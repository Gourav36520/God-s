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
import { inviteTracker } from "../trackers/invite-tracker.js";

export const data = new SlashCommandBuilder()
  .setName("invite")
  .setDescription("View verified invite statistics")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("leaderboard")
      .setDescription("Show the invite leaderboard")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("daily")
      .setDescription("Show today's invite leaderboard"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("yesterday")
      .setDescription("Show yesterday's invite leaderboard"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "Invite statistics are only available inside a server.",
      ephemeral: true,
    });
    return;
  }

  const period = periodForSubcommand(interaction.options.getSubcommand());
  const entries = inviteTracker.getLeaderboard(guildId, period);
  await interaction.reply({
    embeds: [
      trackerEmbed(
        `Invite Leaderboard · ${periodTitle(period)}`,
        formatLeaderboard(
          entries.map(
            (entry, index) =>
              `**${index + 1}.** <@${entry.inviterId}> · ${entry.invites.toLocaleString()} verified invites`,
          ),
          "No verified invites have been recorded for this period yet.",
        ),
      ),
    ],
  });
}
