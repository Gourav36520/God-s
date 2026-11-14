import { createHash, randomInt } from "node:crypto";
import {
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import type {
  Client,
  Guild,
  GuildMember,
  Message,
  VoiceState,
} from "discord.js";
import {
  addLevelXp,
  addPendingLevelingInviteReward,
  awardLevelMessageXp,
  awardLevelVoiceXp,
  ensureLevelingMember,
  getLevelingMemberRank,
  getLevelingRoleRewards,
  getLevelingSettings,
  forfeitPendingLevelingInviteReward,
  listDueLevelingInviteRewards,
  markLevelingMemberDeparted,
  setLevelingInviteRewardStatus,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { calculateLevelProgress } from "./progression.js";
import { renderLevelCard } from "./render.js";
import { kolkataDateKey } from "../trackers/time.js";

const MESSAGE_XP_COOLDOWN_MS = 60_000;
const MESSAGE_SIGNATURE_LIFETIME_MS = 24 * 60 * 60_000;
const MIN_MESSAGE_LENGTH = 5;
const MESSAGE_XP_MIN = 15;
const MESSAGE_XP_MAX_EXCLUSIVE = 26;
const VOICE_AWARD_INTERVAL_MS = 5 * 60_000;
const VOICE_AWARD_INTERVAL_MINUTES = 5;
const VOICE_XP_PER_INTERVAL = 10n;
const VOICE_DAILY_LIMIT_MINUTES = 120;
const VOICE_TICK_MS = 60_000;
const INVITE_ACCOUNT_MIN_AGE_MS = 7 * 24 * 60 * 60_000;
const INVITE_MEMBER_STAY_MS = 7 * 24 * 60 * 60_000;
const INVITE_XP = 500n;

export interface LevelCardData {
  totalXp: bigint;
  recentXp: bigint;
  rank: number;
}

export class LevelingService {
  private client: Client | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly voiceEligibleSince = new Map<string, number>();

  initialize(client: Client): void {
    this.client = client;
    for (const guild of client.guilds.cache.values()) {
      this.syncVoiceEligibility(guild, Date.now());
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick().catch((error) =>
        logger.warn(
          "Leveling background tick failed:",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }, VOICE_TICK_MS);
    this.timer.unref();
    void this.processInviteRewards().catch((error) =>
      logger.warn(
        "Initial leveling invite-reward check failed:",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.voiceEligibleSince.clear();
  }

  async handleMessage(
    message: Message,
    commandPrefix: string | null,
  ): Promise<void> {
    const guildId = message.guildId;
    if (
      !guildId ||
      message.author.bot ||
      message.webhookId ||
      message.system
    ) {
      return;
    }
    const text = message.content.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (text.length < MIN_MESSAGE_LENGTH) return;
    if (commandPrefix && message.content.trimStart().startsWith(commandPrefix)) {
      return;
    }

    const signature = createHash("sha256")
      .update(text.toLocaleLowerCase("en-US"))
      .digest("hex");
    const amount = BigInt(randomInt(MESSAGE_XP_MIN, MESSAGE_XP_MAX_EXCLUSIVE));
    const result = await awardLevelMessageXp({
      guildId,
      userId: message.author.id,
      messageId: message.id,
      signature,
      amount,
      cooldownMs: MESSAGE_XP_COOLDOWN_MS,
      signatureLifetimeMs: MESSAGE_SIGNATURE_LIFETIME_MS,
    });
    if (result && !result.duplicate) {
      await this.handleAward(guildId, message.author.id, result);
    }
  }

  async recordVerifiedInviteJoin(
    member: GuildMember,
    attribution: { inviterId: string | null; verified: boolean },
  ): Promise<void> {
    await ensureLevelingMember(member.guild.id, member.id);
    const joinedAt = member.joinedAt ?? new Date();
    const eligibleAt = new Date(joinedAt.getTime() + INVITE_MEMBER_STAY_MS);
    const inviterId = attribution.inviterId;
    let status: "pending" | "forfeited" = "pending";
    let reason: string | null = null;

    if (member.user.bot) {
      status = "forfeited";
      reason = "invitee_is_bot";
    } else if (!attribution.verified || !inviterId) {
      status = "forfeited";
      reason = "invite_use_not_verified";
    } else if (inviterId === member.id) {
      status = "forfeited";
      reason = "self_invite";
    } else if (
      Date.now() - member.user.createdTimestamp <
      INVITE_ACCOUNT_MIN_AGE_MS
    ) {
      status = "forfeited";
      reason = "discord_account_too_new";
    } else {
      const inviter = await member.client.users
        .fetch(inviterId)
        .catch(() => null);
      if (!inviter || inviter.bot) {
        status = "forfeited";
        reason = "inviter_unavailable_or_bot";
      }
    }

    await addPendingLevelingInviteReward({
      guildId: member.guild.id,
      inviteeId: member.id,
      inviterId: inviterId ?? member.id,
      joinedAt,
      eligibleAt,
      status,
      reason,
    });
  }

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    this.syncVoiceEligibility(newState.guild, Date.now());
    if (oldState.guild.id !== newState.guild.id) {
      this.syncVoiceEligibility(oldState.guild, Date.now());
    }
  }

  async markMemberDeparted(member: GuildMember): Promise<void> {
    await markLevelingMemberDeparted(member.guild.id, member.id);
    await forfeitPendingLevelingInviteReward(
      member.guild.id,
      member.id,
      "invitee_left_before_qualifying",
    );
    this.voiceEligibleSince.delete(`${member.guild.id}:${member.id}`);
  }

  async getCardData(member: GuildMember): Promise<LevelCardData> {
    const record = await ensureLevelingMember(member.guild.id, member.id);
    const rank = await getLevelingMemberRank(
      member.guild.id,
      member.id,
      record.totalXp,
    );
    return {
      totalXp: record.totalXp,
      recentXp: record.recentXp,
      rank,
    };
  }

  async renderCard(member: GuildMember): Promise<Buffer> {
    return renderLevelCard(member, await this.getCardData(member));
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const guild of this.client?.guilds.cache.values() ?? []) {
        this.syncVoiceEligibility(guild, now);
      }
      await this.processVoiceAwards(now);
      await this.processInviteRewards(new Date(now));
    } finally {
      this.ticking = false;
    }
  }

  private syncVoiceEligibility(guild: Guild, now: number): void {
    const eligible = new Set<string>();
    const channelParticipants = new Map<string, VoiceState[]>();
    for (const state of guild.voiceStates.cache.values()) {
      if (!state.channelId || state.channelId === guild.afkChannelId) continue;
      const channel = guild.channels.cache.get(state.channelId);
      if (!channel?.isVoiceBased()) continue;
      const member =
        state.member ?? guild.members.cache.get(state.id) ?? null;
      if (!member || member.user.bot) continue;
      if (
        state.selfMute ||
        state.serverMute ||
        state.selfDeaf ||
        state.serverDeaf ||
        state.suppress
      ) {
        continue;
      }
      const participants = channelParticipants.get(state.channelId) ?? [];
      participants.push(state);
      channelParticipants.set(state.channelId, participants);
    }

    for (const [channelId, participants] of channelParticipants) {
      if (participants.length < 2) continue;
      for (const state of participants) {
        eligible.add(`${guild.id}:${state.id}`);
      }
    }

    const guildPrefix = `${guild.id}:`;
    for (const key of this.voiceEligibleSince.keys()) {
      if (key.startsWith(guildPrefix) && !eligible.has(key)) {
        this.voiceEligibleSince.delete(key);
      }
    }
    for (const key of eligible) {
      if (!this.voiceEligibleSince.has(key)) {
        this.voiceEligibleSince.set(key, now);
      }
    }
  }

  private async processVoiceAwards(now: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    for (const [key, eligibleSince] of this.voiceEligibleSince) {
      if (now - eligibleSince < VOICE_AWARD_INTERVAL_MS) continue;
      const separator = key.indexOf(":");
      const guildId = key.slice(0, separator);
      const userId = key.slice(separator + 1);
      const dayKey = kolkataDateKey(now);
      const result = await awardLevelVoiceXp({
        guildId,
        userId,
        sourceKey: `${dayKey}:${Math.floor(now / VOICE_AWARD_INTERVAL_MS)}`,
        dayKey,
        amount: VOICE_XP_PER_INTERVAL,
        intervalMs: VOICE_AWARD_INTERVAL_MS,
        intervalMinutes: VOICE_AWARD_INTERVAL_MINUTES,
        dailyLimitMinutes: VOICE_DAILY_LIMIT_MINUTES,
        now: new Date(now),
      });
      if (result && !result.duplicate) {
        await this.handleAward(guildId, userId, result);
      }
      this.voiceEligibleSince.set(key, now);
    }
  }

  private async processInviteRewards(now = new Date()): Promise<void> {
    const rewards = await listDueLevelingInviteRewards(now, 100);
    for (const reward of rewards) {
      const guild = this.client?.guilds.cache.get(reward.guildId);
      const invitee = guild
        ? await guild.members.fetch(reward.inviteeId).catch(() => null)
        : null;
      if (!invitee) {
        await setLevelingInviteRewardStatus(
          reward.guildId,
          reward.inviteeId,
          "forfeited",
          "invitee_left_before_qualifying",
        );
        continue;
      }

      const result = await addLevelXp(
        reward.guildId,
        reward.inviterId,
        "invite",
        reward.inviteeId,
        INVITE_XP,
        now,
      );
      if (result && !result.duplicate) {
        await this.handleAward(reward.guildId, reward.inviterId, result);
      }
      await setLevelingInviteRewardStatus(
        reward.guildId,
        reward.inviteeId,
        "awarded",
        null,
        now,
      );
    }
  }

  private async handleAward(
    guildId: string,
    userId: string,
    award: { previousXp: bigint; totalXp: bigint; duplicate: boolean },
  ): Promise<void> {
    if (award.duplicate) return;
    const previousLevel = calculateLevelProgress(award.previousXp).level;
    const currentProgress = calculateLevelProgress(award.totalXp);
    if (currentProgress.level <= previousLevel) return;

    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) return;
    const member =
      guild.members.cache.get(userId) ??
      (await guild.members.fetch(userId).catch(() => null));
    if (member) {
      await this.applyLevelRewards(
        member,
        previousLevel,
        currentProgress.level,
      );
    }
    await this.announceLevelUp(
      guild,
      userId,
      currentProgress.level,
      currentProgress.className,
    );
  }

  private async applyLevelRewards(
    member: GuildMember,
    previousLevel: number,
    currentLevel: number,
  ): Promise<void> {
    const rewards = await getLevelingRoleRewards(member.guild.id);
    const botMember =
      member.guild.members.me ??
      (await member.guild.members.fetchMe().catch(() => null));
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return;

    for (const reward of rewards) {
      if (reward.level <= previousLevel || reward.level > currentLevel) continue;
      const role =
        member.guild.roles.cache.get(reward.roleId) ??
        (await member.guild.roles.fetch(reward.roleId).catch(() => null));
      if (
        !role ||
        role.managed ||
        role.position >= botMember.roles.highest.position ||
        member.roles.cache.has(role.id)
      ) {
        continue;
      }
      await member.roles.add(role, `Reached level ${reward.level}`).catch((error) =>
        logger.warn(
          `Could not assign level ${reward.level} role ${role.id} to ${member.id}:`,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private async announceLevelUp(
    guild: Guild,
    userId: string,
    level: number,
    className: string,
  ): Promise<void> {
    const settings = await getLevelingSettings(guild.id);
    if (!settings?.announcementChannelId) return;
    const channel = await guild.channels
      .fetch(settings.announcementChannelId)
      .catch(() => null);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement)
    ) {
      return;
    }
    const botMember =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!permissions?.has(PermissionFlagsBits.SendMessages)) return;
    await channel
      .send({
        content: `<@${userId}> reached level ${level.toLocaleString()} · **${className}**!`,
        allowedMentions: { parse: [], users: [userId] },
      })
      .catch((error) =>
        logger.warn(
          `Could not announce level ${level} for ${userId} in guild ${guild.id}:`,
          error instanceof Error ? error.message : String(error),
        ),
      );
  }

}

export const levelingService = new LevelingService();
