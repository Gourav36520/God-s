import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { securityManager } from "../lib/registry.js";
import { welcomeGoodbyeStore } from "../welcome-goodbye/config-store.js";
import type { GreetingKind } from "../welcome-goodbye/types.js";
import { requireGuildAdministrator, settingSavedEmbed } from "./welcome-goodbye-helpers.js";
import {
  arrowLine,
  createGodsEmbed,
  GODS_EMOJI,
} from "./ui.js";

export const data = new SlashCommandBuilder()
  .setName("set")
  .setDescription("Configure server settings")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup((group) =>
    group
      .setName("general")
      .setDescription("General server settings")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("prefix")
          .setDescription("Set the server's message prefix")
          .addStringOption((option) =>
            option
              .setName("prefix")
              .setDescription("The new message prefix")
              .setMinLength(1)
              .setMaxLength(5)
              .setRequired(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("welcome")
      .setDescription("Welcome message settings")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("channel")
          .setDescription("Choose where Welcome messages are sent")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Choose a server text channel")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("goodbye")
      .setDescription("Goodbye message settings")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("channel")
          .setDescription("Choose where Goodbye messages are sent")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Choose a server text channel")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true),
          ),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = await requireGuildAdministrator(interaction);
  if (!guildId) return;

  const group = interaction.options.getSubcommandGroup(true);
  const subcommand = interaction.options.getSubcommand(true);

  if (group === "general" && subcommand === "prefix") {
    const prefix = interaction.options.getString("prefix", true);
    if (!prefix || /\s/u.test(prefix) || [...prefix].length > 5) {
      await interaction.reply({
        embeds: [
          createGodsEmbed({
            title: "Prefix Not Saved",
            description: [
              "Choose a prefix containing 1–5 characters and no spaces.",
              "",
              arrowLine("Try next", "Enter a shorter prefix without spaces."),
            ].join("\n"),
            emoji: GODS_EMOJI.settings,
            tone: "error",
          }),
        ],
        ephemeral: true,
      });
      return;
    }

    try {
      await securityManager.updateConfig(guildId, { prefix });
      await interaction.reply({
        embeds: [
          createGodsEmbed({
            title: "Prefix Updated",
            description: [
              "Your server's message prefix has been saved.",
              "",
              arrowLine("New prefix", `\`${prefix}\``),
              arrowLine("Try next", `Use \`${prefix}help\` to open the Help Centre.`),
            ].join("\n"),
            emoji: GODS_EMOJI.settings,
            tone: "success",
          }),
        ],
        ephemeral: true,
      });
    } catch {
      await interaction.reply({
        embeds: [
          createGodsEmbed({
            title: "Prefix Not Saved",
            description: "The setting could not be saved. Please try again.",
            emoji: GODS_EMOJI.settings,
            tone: "error",
          }),
        ],
        ephemeral: true,
      });
    }
    return;
  }

  if ((group === "welcome" || group === "goodbye") && subcommand === "channel") {
    const kind = group as GreetingKind;
    const channel = interaction.options.getChannel(
      "channel",
      true,
      [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    );
    try {
      await welcomeGoodbyeStore.updateFlow(guildId, kind, {
        channelId: channel.id,
        enabled: true,
      });
      await interaction.reply({
        embeds: [
          settingSavedEmbed(kind, "channel", `<#${channel.id}>. It is now ON.`),
        ],
        ephemeral: true,
      });
    } catch {
      await interaction.reply({
        embeds: [
          createGodsEmbed({
            title: "Channel Not Saved",
            description: "The channel could not be saved. Please choose it again and retry.",
            emoji: GODS_EMOJI.settings,
            tone: "error",
          }),
        ],
        ephemeral: true,
      });
    }
  }
}