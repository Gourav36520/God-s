import { loadTrackerJson, saveTrackerJson } from "./json-storage.js";
import { dateKeyForPeriod, type LeaderboardPeriod } from "./time.js";

interface MessageUserStats {
  total: number;
  daily: Record<string, number>;
}

interface MessageGuildStats {
  users: Record<string, MessageUserStats>;
}

interface MessageTrackerData {
  version: 1;
  guilds: Record<string, MessageGuildStats>;
}

export interface MessageLeaderboardEntry {
  userId: string;
  count: number;
}

const FILE_NAME = "message-tracker.json";

function emptyData(): MessageTrackerData {
  return { version: 1, guilds: {} };
}

export class MessageTracker {
  private readonly data = loadTrackerJson(FILE_NAME, emptyData);

  recordMessage(guildId: string, userId: string, timestamp = Date.now()): void {
    const guild = (this.data.guilds[guildId] ??= { users: {} });
    const user = (guild.users[userId] ??= { total: 0, daily: {} });
    const dateKey = dateKeyForPeriod("today", timestamp);

    user.total += 1;
    user.daily[dateKey] = (user.daily[dateKey] ?? 0) + 1;
    saveTrackerJson(FILE_NAME, this.data);
  }

  getUserStats(
    guildId: string,
    userId: string,
    now = Date.now(),
  ): { today: number; total: number } {
    const user = this.data.guilds[guildId]?.users[userId];
    const today = dateKeyForPeriod("today", now);
    return {
      today: user?.daily[today] ?? 0,
      total: user?.total ?? 0,
    };
  }

  getLeaderboard(
    guildId: string,
    period: LeaderboardPeriod,
    now = Date.now(),
  ): MessageLeaderboardEntry[] {
    const dateKey =
      period === "all-time" ? null : dateKeyForPeriod(period, now);
    return Object.entries(this.data.guilds[guildId]?.users ?? {})
      .map(([userId, user]) => ({
        userId,
        count: dateKey ? (user.daily[dateKey] ?? 0) : user.total,
      }))
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count || left.userId.localeCompare(right.userId))
      .slice(0, 10);
  }
}

export const messageTracker = new MessageTracker();
