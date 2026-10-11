import type { Client } from "discord.js";
import { loadTrackerJson, saveTrackerJson } from "./json-storage.js";
import {
  addIntervalByKolkataDay,
  dateKeyForPeriod,
  type LeaderboardPeriod,
} from "./time.js";

interface VoiceUserStats {
  totalMs: number;
  daily: Record<string, number>;
}

interface ActiveVoiceSession {
  channelId: string;
  cursorAt: number;
}

interface VoiceGuildStats {
  users: Record<string, VoiceUserStats>;
  activeSessions: Record<string, ActiveVoiceSession>;
}

interface VoiceTrackerData {
  version: 1;
  guilds: Record<string, VoiceGuildStats>;
}

export interface VoiceLeaderboardEntry {
  userId: string;
  durationMs: number;
}

const FILE_NAME = "voice-tracker.json";
const CHECKPOINT_INTERVAL_MS = 60_000;

function emptyData(): VoiceTrackerData {
  return { version: 1, guilds: {} };
}

function emptyGuild(): VoiceGuildStats {
  return { users: {}, activeSessions: {} };
}

export class VoiceTracker {
  private readonly data = loadTrackerJson(FILE_NAME, emptyData);
  private readonly checkpointTimer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor() {
    let recoveredSession = false;
    for (const guild of Object.values(this.data.guilds)) {
      if (Object.keys(guild.activeSessions ?? {}).length > 0) {
        recoveredSession = true;
      }
      // Persisted sessions are deliberately not extended across restarts.
      guild.activeSessions = {};
    }
    if (recoveredSession) saveTrackerJson(FILE_NAME, this.data);

    this.checkpointTimer = setInterval(() => {
      try {
        this.checkpoint();
      } catch (error) {
        console.error(
          `Voice tracker checkpoint failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, CHECKPOINT_INTERVAL_MS);
    this.checkpointTimer.unref();
  }

  handleVoiceStateChange(
    guildId: string,
    userId: string,
    oldChannelId: string | null,
    newChannelId: string | null,
    now = Date.now(),
  ): void {
    if (oldChannelId === newChannelId) return;

    const guild = this.getGuild(guildId);
    let changed = this.settleSession(guild, userId, now);
    if (newChannelId) {
      guild.activeSessions[userId] = { channelId: newChannelId, cursorAt: now };
      changed = true;
    }
    if (changed) saveTrackerJson(FILE_NAME, this.data);
  }

  resumeConnected(client: Client, now = Date.now()): void {
    let changed = false;
    for (const guild of client.guilds.cache.values()) {
      const trackerGuild = this.getGuild(guild.id);
      for (const state of guild.voiceStates.cache.values()) {
        if (!state.channelId) continue;
        const isBot =
          state.member?.user.bot ??
          guild.members.cache.get(state.id)?.user.bot ??
          false;
        if (isBot || trackerGuild.activeSessions[state.id]) continue;

        trackerGuild.activeSessions[state.id] = {
          channelId: state.channelId,
          cursorAt: now,
        };
        changed = true;
      }
    }
    if (changed) saveTrackerJson(FILE_NAME, this.data);
  }

  checkpoint(now = Date.now()): void {
    let changed = false;
    for (const guild of Object.values(this.data.guilds)) {
      for (const userId of Object.keys(guild.activeSessions)) {
        changed = this.settleSession(guild, userId, now) || changed;
      }
    }
    if (changed) saveTrackerJson(FILE_NAME, this.data);
  }

  shutdown(now = Date.now()): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.checkpointTimer);

    let changed = false;
    for (const guild of Object.values(this.data.guilds)) {
      for (const userId of Object.keys(guild.activeSessions)) {
        changed = this.settleSession(guild, userId, now) || changed;
        delete guild.activeSessions[userId];
        changed = true;
      }
    }
    if (changed) saveTrackerJson(FILE_NAME, this.data);
  }

  getUserStats(
    guildId: string,
    userId: string,
    now = Date.now(),
  ): { todayMs: number; totalMs: number } {
    const guild = this.data.guilds[guildId];
    const user = guild?.users[userId];
    const today = dateKeyForPeriod("today", now);
    let todayMs = user?.daily[today] ?? 0;
    let totalMs = user?.totalMs ?? 0;
    const active = guild?.activeSessions[userId];
    if (active && now > active.cursorAt) {
      addIntervalByKolkataDay(active.cursorAt, now, (dateKey, durationMs) => {
        totalMs += durationMs;
        if (dateKey === today) todayMs += durationMs;
      });
    }
    return {
      todayMs,
      totalMs,
    };
  }

  getLeaderboard(
    guildId: string,
    period: LeaderboardPeriod,
    now = Date.now(),
  ): VoiceLeaderboardEntry[] {
    const guild = this.data.guilds[guildId];
    const dateKey =
      period === "all-time" ? null : dateKeyForPeriod(period, now);
    const userIds = new Set([
      ...Object.keys(guild?.users ?? {}),
      ...Object.keys(guild?.activeSessions ?? {}),
    ]);
    return [...userIds]
      .map((userId) => {
        const user = guild?.users[userId];
        let durationMs = dateKey
          ? (user?.daily[dateKey] ?? 0)
          : (user?.totalMs ?? 0);
        const active = guild?.activeSessions[userId];
        if (active && now > active.cursorAt) {
          if (!dateKey) {
            durationMs += now - active.cursorAt;
          } else {
            addIntervalByKolkataDay(
              active.cursorAt,
              now,
              (intervalDate, intervalMs) => {
                if (intervalDate === dateKey) durationMs += intervalMs;
              },
            );
          }
        }
        return { userId, durationMs };
      })
      .filter((entry) => entry.durationMs > 0)
      .sort(
        (left, right) =>
          right.durationMs - left.durationMs ||
          left.userId.localeCompare(right.userId),
      )
      .slice(0, 10);
  }

  private getGuild(guildId: string): VoiceGuildStats {
    return (this.data.guilds[guildId] ??= emptyGuild());
  }

  private settleSession(
    guild: VoiceGuildStats,
    userId: string,
    now: number,
  ): boolean {
    const session = guild.activeSessions[userId];
    if (!session || now <= session.cursorAt) return false;

    const user = (guild.users[userId] ??= { totalMs: 0, daily: {} });
    addIntervalByKolkataDay(session.cursorAt, now, (dateKey, durationMs) => {
      user.totalMs += durationMs;
      user.daily[dateKey] = (user.daily[dateKey] ?? 0) + durationMs;
    });
    session.cursorAt = now;
    return true;
  }
}

export const voiceTracker = new VoiceTracker();
