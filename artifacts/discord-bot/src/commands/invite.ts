import {
  ChannelType,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { securityManager } from "../lib/registry.js";
import {
  formatLeaderboard,
  periodForSubcommand,
  periodTitle,
  trackerEmbed,
} from "./tracker-command-utils.js";
import { inviteTracker } from "../trackers/invite-tracker.js";
import { createGodsEmbed, GODS_EMOJI } from "./ui.js";

export const data = new SlashCommandBuilder()
  .setName("invite")
  .setDescription("View verified invite statistics and configure notifications")
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
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("channel")
      .setDescription("Choose where new-member invite notifications are sent")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("The text channel for invite notifications")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "channel") {
    if (!guildId) {
      await interaction.reply({
        content: "Invite notifications can only be configured inside a server.",
        ephemeral: true,
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: "Only a server Administrator can configure invite notifications.",
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.options.getChannel(
      "channel",
      true,
      [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    );
    try {
      await securityManager.updateConfig(guildId, {
        inviteChannelId: channel.id,
      });
      await interaction.reply({
        embeds: [
          createGodsEmbed({
            title: "Invite Channel Updated",
            description: `New-member invite notifications will be sent to <#${channel.id}>.`,
            emoji: GODS_EMOJI.settings,
            tone: "success",
          }),
        ],
        ephemeral: true,
      });
    } catch {
      await interaction.reply({
        content: "The invite notification channel could not be saved. Please try again.",
        ephemeral: true,
      });
    }
    return;
  }

  if (!guildId) {
    await interaction.reply({
      content: "Invite statistics are only available inside a server.",
      ephemeral: true,
    });
    return;
  }

  const period = periodForSubcommand(subcommand);
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
