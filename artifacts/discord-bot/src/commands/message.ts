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
import { messageTracker } from "../trackers/message-tracker.js";

export const data = new SlashCommandBuilder()
  .setName("message")
  .setDescription("View message activity statistics")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("leaderboard")
      .setDescription("Show the message leaderboard")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("daily")
      .setDescription("Show today's message leaderboard"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("yesterday")
      .setDescription("Show yesterday's message leaderboard"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("user")
      .setDescription("Show a member's message counts")
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
      content: "Message statistics are only available inside a server.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "user") {
    const user = interaction.options.getUser("user", true);
    const stats = messageTracker.getUserStats(guildId, user.id);
    await interaction.reply({
      embeds: [
        trackerEmbed(
          `Message Stats · ${user.username}`,
          [
            `**Today:** ${stats.today.toLocaleString()}`,
            `**All-time:** ${stats.total.toLocaleString()}`,
          ].join("\n"),
        ),
      ],
    });
    return;
  }

  const period = periodForSubcommand(subcommand);
  const entries = messageTracker.getLeaderboard(guildId, period);
  await interaction.reply({
    embeds: [
      trackerEmbed(
        `Message Leaderboard · ${periodTitle(period)}`,
        formatLeaderboard(
          entries.map(
            (entry, index) =>
              `**${index + 1}.** <@${entry.userId}> · ${entry.count.toLocaleString()} messages`,
          ),
          "No messages have been recorded for this period yet.",
        ),
      ),
    ],
  });
}
