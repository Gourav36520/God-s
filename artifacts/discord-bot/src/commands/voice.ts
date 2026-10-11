import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import {
  formatLeaderboard,
  periodTitle,
  selectedPeriod,
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
      .addStringOption((option) =>
        option
          .setName("period")
          .setDescription("Which period to rank")
          .setRequired(false)
          .addChoices(
            { name: "All-time", value: "all-time" },
            { name: "Today", value: "today" },
            { name: "Yesterday", value: "yesterday" },
          ),
      ),
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

  if (interaction.options.getSubcommand() === "user") {
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

  const period = selectedPeriod(interaction);
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
