import { EmbedBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import {
  dateKeyForPeriod,
  periodLabel,
  type LeaderboardPeriod,
} from "../trackers/time.js";

export function periodForSubcommand(subcommand: string): LeaderboardPeriod {
  if (subcommand === "daily") return "today";
  if (subcommand === "yesterday") return "yesterday";
  return "all-time";
}

export function periodTitle(
  period: LeaderboardPeriod,
  now = Date.now(),
): string {
  if (period === "all-time") return "All-time";
  const day = dateKeyForPeriod(period, now);
  return `${periodLabel(period)} · ${day} Asia/Kolkata`;
}

export function trackerEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x6d5dfc)
    .setTitle(title)
    .setDescription(description);
}

export function formatLeaderboard(
  lines: string[],
  emptyMessage: string,
): string {
  return lines.length > 0 ? lines.join("\n") : emptyMessage;
}
