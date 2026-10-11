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
import { inviteTracker } from "../trackers/invite-tracker.js";

export const data = new SlashCommandBuilder()
  .setName("invite")
  .setDescription("View verified invite statistics")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("leaderboard")
      .setDescription("Show the invite leaderboard")
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

  const period = selectedPeriod(interaction);
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
