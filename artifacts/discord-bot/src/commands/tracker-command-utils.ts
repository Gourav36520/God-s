import { EmbedBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import {
  dateKeyForPeriod,
  periodLabel,
  type LeaderboardPeriod,
} from "../trackers/time.js";

export function selectedPeriod(
  interaction: ChatInputCommandInteraction,
): LeaderboardPeriod {
  const value = interaction.options.getString("period") ?? "all-time";
  return value === "today" || value === "yesterday" ? value : "all-time";
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
