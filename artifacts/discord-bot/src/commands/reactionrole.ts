import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger.js";
import {
  addMapping,
  assignExistingMessage,
  createPanel,
  deletePanel,
  editPanel,
  listPanels,
  removeMapping,
  showConfig,
  withPanelOperationLock,
} from "../reactionrole/panel-handlers.js";
import { REACTION_ROLE_EMOJI } from "../reactionrole/service.js";
import {
  ReactionRoleCommandError,
  editNotice,
} from "../reactionrole/panel-support.js";
import { createGodsEmbed } from "./ui.js";

export {
  handleReactionRoleListButton,
  isReactionRoleListButton,
} from "../reactionrole/panel-handlers.js";

export const data = new SlashCommandBuilder()
  .setName("reactionrole")
  .setDescription("Configure emoji-based Reaction Role panels")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Create a Reaction Role panel")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Text channel where the panel will be posted")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("title")
          .setDescription("Panel title")
          .setMaxLength(100),
      )
      .addStringOption((option) =>
        option
          .setName("description")
          .setDescription("Instructions shown in the panel")
          .setMaxLength(1_000),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add an emoji and role to an existing panel")
      .addStringOption((option) =>
        option
          .setName("message-id")
          .setDescription("ID of the configured panel message")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("emoji")
          .setDescription("Unicode emoji or custom emoji")
          .setMaxLength(100)
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to grant").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove an emoji and role mapping from a panel")
      .addStringOption((option) =>
        option
          .setName("message-id")
          .setDescription("ID of the configured panel message")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("emoji")
          .setDescription("Emoji mapping to remove")
          .setMaxLength(100)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription("Edit a panel created by this bot")
      .addStringOption((option) =>
        option
          .setName("message-id")
          .setDescription("ID of the configured panel message")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("title").setDescription("New panel title").setMaxLength(100),
      )
      .addStringOption((option) =>
        option
          .setName("description")
          .setDescription("New panel instructions")
          .setMaxLength(1_000),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list").setDescription("List configured Reaction Role panels"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Remove a panel configuration without deleting its message")
      .addStringOption((option) =>
        option
          .setName("message-id")
          .setDescription("ID of the panel message")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("config")
      .setDescription("Show Reaction Role settings for this server"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("assign")
      .setDescription("Attach Reaction Role functionality to an existing message")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel containing the existing message")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("message-id")
          .setDescription("ID of the existing message")
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("emoji")
          .setDescription("Unicode emoji or custom emoji")
          .setMaxLength(100)
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Role to grant").setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Server Required",
          description: "Run this command in the server you want to configure.",
          emoji: REACTION_ROLE_EMOJI,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Manage Server Permission Required",
          description:
            "Only members with Manage Server permission can configure Reaction Roles.",
          emoji: REACTION_ROLE_EMOJI,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  try {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    switch (interaction.options.getSubcommand()) {
      case "create":
        await createPanel(interaction, guild);
        break;
      case "add":
        await withPanelOperationLock(
          `${guild.id}:${interaction.options.getString("message-id", true)}`,
          () => addMapping(interaction, guild),
        );
        break;
      case "remove":
        await withPanelOperationLock(
          `${guild.id}:${interaction.options.getString("message-id", true)}`,
          () => removeMapping(interaction, guild),
        );
        break;
      case "edit":
        await withPanelOperationLock(
          `${guild.id}:${interaction.options.getString("message-id", true)}`,
          () => editPanel(interaction, guild),
        );
        break;
      case "list":
        await listPanels(interaction, guild.id);
        break;
      case "delete":
        await withPanelOperationLock(
          `${guild.id}:${interaction.options.getString("message-id", true)}`,
          () => deletePanel(interaction, guild),
        );
        break;
      case "config":
        await showConfig(interaction, guild.id);
        break;
      case "assign":
        await withPanelOperationLock(
          `${guild.id}:${interaction.options.getString("message-id", true)}`,
          () => assignExistingMessage(interaction, guild),
        );
        break;
      default:
        throw new ReactionRoleCommandError(
          "Unknown Reaction Role Command",
          "That Reaction Role action is not available.",
        );
    }
  } catch (error) {
    if (error instanceof ReactionRoleCommandError) {
      await editNotice(interaction, error.title, error.message, "error");
      return;
    }
    logger.error(
      `[REACTION ROLE] Command failed in guild ${interaction.guildId}:`,
      error instanceof Error ? error.stack : error,
    );
    await editNotice(
      interaction,
      "Reaction Role Error",
      "The request could not be completed. No unrelated Discord message was deleted.",
      "error",
    );
  }
}