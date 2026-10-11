import type { Client, Guild, GuildMember, Invite } from "discord.js";
import { logger } from "../lib/logger.js";
import { findVerifiedInviteUse, type InviteSnapshot } from "./invite-attribution.js";
import { loadTrackerJson, saveTrackerJson } from "./json-storage.js";
import { dateKeyForPeriod, type LeaderboardPeriod, kolkataDateKey } from "./time.js";

interface TrackedInviteJoin {
  memberId: string;
  joinedAt: string | null;
  inviterId: string | null;
  inviteCode: string | null;
  verified: boolean;
}

interface InviteInviterStats {
  total: number;
  daily: Record<string, number>;
}

interface InviteGuildData {
  invites: Record<string, InviteSnapshot>;
  inviters: Record<string, InviteInviterStats>;
  joins: Record<string, TrackedInviteJoin>;
}

interface InviteTrackerData {
  version: 1;
  guilds: Record<string, InviteGuildData>;
}

export interface InviteLeaderboardEntry {
  inviterId: string;
  invites: number;
}

const FILE_NAME = "invite-tracker.json";

function emptyData(): InviteTrackerData {
  return { version: 1, guilds: {} };
}

function emptyGuild(): InviteGuildData {
  return { invites: {}, inviters: {}, joins: {} };
}

function snapshotInvites(
  invites: Awaited<ReturnType<Guild["invites"]["fetch"]>>,
): Record<string, InviteSnapshot> {
  const snapshot: Record<string, InviteSnapshot> = {};
  for (const invite of invites.values()) {
    snapshot[invite.code] = {
      uses: invite.uses,
      inviterId: invite.inviter?.id ?? null,
    };
  }
  return snapshot;
}

export class InviteTracker {
  private readonly data = loadTrackerJson(FILE_NAME, emptyData);
  private readonly initializedGuilds = new Set<string>();
  private readonly pendingGuildJoins = new Map<string, Promise<void>>();

  async initialize(client: Client): Promise<void> {
    for (const guild of client.guilds.cache.values()) {
      try {
        const invites = await guild.invites.fetch({ cache: false });
        this.getGuild(guild.id).invites = snapshotInvites(invites);
        this.initializedGuilds.add(guild.id);
        saveTrackerJson(FILE_NAME, this.data);
      } catch (error) {
        logger.warn(
          `Invite tracker could not read invites for guild ${guild.id}; join attribution will remain unknown until invite access is available: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  recordInviteCreate(invite: Invite): void {
    const guild = invite.guild;
    if (!guild) return;

    this.getGuild(guild.id).invites[invite.code] = {
      uses: invite.uses ?? 0,
      inviterId: invite.inviter?.id ?? null,
    };
    this.initializedGuilds.add(guild.id);
    saveTrackerJson(FILE_NAME, this.data);
  }

  recordInviteDelete(invite: Invite): void {
    const guild = invite.guild;
    if (!guild) return;

    delete this.getGuild(guild.id).invites[invite.code];
    saveTrackerJson(FILE_NAME, this.data);
  }

  async recordJoin(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;
    const previous = this.pendingGuildJoins.get(guildId) ?? Promise.resolve();
    const work = previous.then(() => this.processJoin(member));
    const tail = work.then(
      () => undefined,
      () => undefined,
    );
    this.pendingGuildJoins.set(guildId, tail);

    try {
      await work;
    } finally {
      if (this.pendingGuildJoins.get(guildId) === tail) {
        this.pendingGuildJoins.delete(guildId);
      }
    }
  }

  getLatestJoin(guildId: string, memberId: string): TrackedInviteJoin | null {
    const matches = Object.values(this.data.guilds[guildId]?.joins ?? {})
      .filter((join) => join.memberId === memberId)
      .sort((left, right) => {
        const leftTime = left.joinedAt ? Date.parse(left.joinedAt) : 0;
        const rightTime = right.joinedAt ? Date.parse(right.joinedAt) : 0;
        return rightTime - leftTime;
      });
    return matches[0] ?? null;
  }

  getLeaderboard(
    guildId: string,
    period: LeaderboardPeriod,
    now = Date.now(),
  ): InviteLeaderboardEntry[] {
    const dateKey =
      period === "all-time" ? null : dateKeyForPeriod(period, now);
    return Object.entries(this.data.guilds[guildId]?.inviters ?? {})
      .map(([inviterId, stats]) => ({
        inviterId,
        invites: dateKey ? (stats.daily[dateKey] ?? 0) : stats.total,
      }))
      .filter((entry) => entry.invites > 0)
      .sort(
        (left, right) =>
          right.invites - left.invites ||
          left.inviterId.localeCompare(right.inviterId),
      )
      .slice(0, 10);
  }

  private async processJoin(member: GuildMember): Promise<void> {
    const guildId = member.guild.id;
    const guild = this.getGuild(guildId);
    const previous = this.initializedGuilds.has(guildId)
      ? guild.invites
      : undefined;
    let attribution: { inviterId: string; code: string } | null = null;

    try {
      const current = snapshotInvites(
        await member.guild.invites.fetch({ cache: false }),
      );
      if (previous) {
        attribution = findVerifiedInviteUse(previous, current);
      }
      guild.invites = current;
      this.initializedGuilds.add(guildId);
    } catch (error) {
      logger.warn(
        `Invite tracker could not verify the join of ${member.id} in guild ${guildId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const joinedAt = member.joinedAt?.toISOString() ?? null;
    const joinKey = `${member.id}:${joinedAt ?? "unknown"}`;
    if (guild.joins[joinKey]) {
      saveTrackerJson(FILE_NAME, this.data);
      return;
    }

    guild.joins[joinKey] = {
      memberId: member.id,
      joinedAt,
      inviterId: attribution?.inviterId ?? null,
      inviteCode: attribution?.code ?? null,
      verified: attribution !== null,
    };

    if (attribution) {
      const inviter =
        (guild.inviters[attribution.inviterId] ??= { total: 0, daily: {} });
      inviter.total += 1;
      const dateKey = joinedAt
        ? kolkataDateKey(Date.parse(joinedAt))
        : dateKeyForPeriod("today");
      inviter.daily[dateKey] = (inviter.daily[dateKey] ?? 0) + 1;
    }

    saveTrackerJson(FILE_NAME, this.data);
  }

  private getGuild(guildId: string): InviteGuildData {
    return (this.data.guilds[guildId] ??= emptyGuild());
  }
}

export const inviteTracker = new InviteTracker();
