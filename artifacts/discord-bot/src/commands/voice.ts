import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import {
  formatLeaderboard,
  periodForSubcommand,
  periodTitle,
  trackerEmbed,
} from "./tracker-command-utils.js";
import { voiceTracker } from "../trackers/voice-tracker.js";
import { formatDuration } from "../trackers/time.js";

export const data = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("View voice activity statistics")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("leaderboard")
      .setDescription("Show the voice leaderboard")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("daily")
      .setDescription("Show today's voice leaderboard"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("yesterday")
      .setDescription("Show yesterday's voice leaderboard"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("user")
      .setDescription("Show a member's voice duration")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("The member to look up")
          .setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "Voice statistics are only available inside a server.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "user") {
    const user = interaction.options.getUser("user", true);
    const stats = voiceTracker.getUserStats(guildId, user.id);
    await interaction.reply({
      embeds: [
        trackerEmbed(
          `Voice Stats · ${user.username}`,
          [
            `**Today:** ${formatDuration(stats.todayMs)}`,
            `**All-time:** ${formatDuration(stats.totalMs)}`,
          ].join("\n"),
        ),
      ],
    });
    return;
  }

  const period = periodForSubcommand(subcommand);
  const entries = voiceTracker.getLeaderboard(guildId, period);
  await interaction.reply({
    embeds: [
      trackerEmbed(
        `Voice Leaderboard · ${periodTitle(period)}`,
        formatLeaderboard(
          entries.map(
            (entry, index) =>
              `**${index + 1}.** <@${entry.userId}> · ${formatDuration(entry.durationMs)}`,
          ),
          "No voice time has been recorded for this period yet.",
        ),
      ),
    ],
  });
}
