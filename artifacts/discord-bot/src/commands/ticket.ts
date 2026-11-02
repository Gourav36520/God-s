import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { TextChannel } from "discord.js";
import { createGodsEmbed, GODS_EMOJI } from "./ui.js";
import { requireGuildAdministrator } from "./welcome-goodbye-helpers.js";
import { ticketConfigStore } from "../tickets/config-store.js";
import { getTicketPanelMissingItems } from "../tickets/core.js";
import {
  buildTicketConfigPanel,
  buildTicketEmbedPicker,
  buildTicketPanelButtonRow,
} from "../tickets/views.js";
import { welcomeGoodbyeStore } from "../welcome-goodbye/config-store.js";
import { buildEmbed, GreetingOutputError } from "../welcome-goodbye/render.js";

export const data = new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Configure and publish the server ticket system")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("config")
      .setDescription("Configure the Ticket role, category, channels, and status"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("embed")
      .setDescription("Choose a saved embed for the ticket panel"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("panel")
      .setDescription("Send the configured ticket panel"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = await requireGuildAdministrator(interaction);
  if (!guildId || !interaction.guild) return;

  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === "config") {
    const config = ticketConfigStore.get(guildId);
    const embedConfig = welcomeGoodbyeStore.get(guildId);
    const panelEmbed = config.panelEmbedId
      ? embedConfig.embeds.find((embed) => embed.id === config.panelEmbedId)
      : undefined;
    await interaction.reply({
      ...buildTicketConfigPanel({
        guildId,
        userId: interaction.user.id,
        config,
        panelEmbed,
      }),
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "embed") {
    const config = ticketConfigStore.get(guildId);
    await interaction.reply({
      ...buildTicketEmbedPicker({
        guildId,
        userId: interaction.user.id,
        page: 0,
        config: welcomeGoodbyeStore.get(guildId),
        selectedEmbedId: config.panelEmbedId,
      }),
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "panel") {
    await publishPanel(interaction, guildId);
    return;
  }

  await interaction.reply({
    embeds: [
      createGodsEmbed({
        title: "Unknown Ticket Command",
        description: `\`/ticket ${subcommand}\` is not supported. Use \`/ticket config\`, \`/ticket embed\`, or \`/ticket panel\`.`,
        emoji: GODS_EMOJI.settings,
        tone: "error",
      }),
    ],
    ephemeral: true,
  });
}

async function publishPanel(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild!;
  const config = ticketConfigStore.get(guildId);
  const embedConfig = welcomeGoodbyeStore.get(guildId);
  const savedEmbed = config.panelEmbedId
    ? embedConfig.embeds.find((embed) => embed.id === config.panelEmbedId)
    : undefined;
  const missing = getTicketPanelMissingItems(config, Boolean(savedEmbed));

  if (config.staffRoleId) {
    const role = await guild.roles.fetch(config.staffRoleId).catch(() => null);
    if (!role) missing.push("Staff Role (selected role no longer exists)");
    else if (role.id === guild.roles.everyone.id) {
      missing.push("Staff Role (@everyone cannot be used)");
    }
  }

  if (config.categoryId) {
    const category = await guild.channels.fetch(config.categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      missing.push("Ticket Category (selected channel is missing or is not a category)");
    }
  }

  let panelChannel = null;
  if (config.panelChannelId) {
    panelChannel = await guild.channels.fetch(config.panelChannelId).catch(() => null);
    if (
      !panelChannel ||
      (panelChannel.type !== ChannelType.GuildText &&
        panelChannel.type !== ChannelType.GuildAnnouncement)
    ) {
      missing.push("Panel Channel (selected channel is missing or is not a text channel)");
    }
  }

  let panelEmbed = null;
  let embedError: string | null = null;
  if (savedEmbed) {
    try {
      panelEmbed = buildEmbed(savedEmbed.definition);
      if (!panelEmbed) {
        embedError =
          "Panel Embed has no renderable embed fields. Edit the saved embed to add a title, description, author, image, thumbnail, or footer.";
      }
    } catch (error) {
      embedError =
        error instanceof GreetingOutputError
          ? `Panel Embed is invalid: ${error.message}`
          : "Panel Embed could not be rendered.";
    }
  }
  if (embedError) missing.push(embedError);

  const panelContentParts = [
    savedEmbed?.definition.content.trim() ?? "",
    savedEmbed?.definition.footerUrl
      ? `[Footer link](<${savedEmbed.definition.footerUrl}>)`
      : "",
  ].filter(Boolean);
  const panelContent = panelContentParts.join("\n");
  if (panelContent.length > 2000) {
    missing.push(
      `Panel Embed Message Content (${panelContent.length} characters; Discord allows up to 2000)`,
    );
  }

  if (missing.length > 0) {
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Ticket Panel Not Ready",
          description: [
            "The following exact items need attention:",
            ...missing.map((item) => `• ${item}`),
            "",
            "Set the missing options with `/ticket config` or choose a saved panel embed with `/ticket embed`.",
          ].join("\n"),
          emoji: GODS_EMOJI.settings,
          tone: "warning",
        }),
      ],
    });
    return;
  }

  const channel = panelChannel as TextChannel;
  const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    await interaction.editReply({
      content:
        "I could not verify my server permissions. Confirm that the bot is still a member of this server, then try again.",
    });
    return;
  }
  const permissions = channel.permissionsFor(botMember);
  if (
    !permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])
  ) {
    await interaction.editReply({
      content:
        "Panel Channel permissions are incomplete. Grant the bot View Channel, Send Messages, and Embed Links there.",
    });
    return;
  }

  try {
    const message = await channel.send({
      ...(panelContent ? { content: panelContent } : {}),
      embeds: [panelEmbed!],
      components: [buildTicketPanelButtonRow()],
      allowedMentions: { parse: [] },
    });
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Ticket Panel Sent",
          description: `The panel was posted in <#${channel.id}>. Message ID: \`${message.id}\`.`,
          emoji: GODS_EMOJI.settings,
          tone: "success",
        }),
      ],
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const message =
      code === 50013
        ? "Missing Permissions: grant the bot View Channel, Send Messages, and Embed Links in the configured Panel Channel."
        : code === 50001
          ? "Missing Access: grant the bot access to the configured Panel Channel."
          : `The Ticket panel could not be sent to <#${channel.id}>. Check the channel and bot permissions${error instanceof Error ? `: ${error.message}` : "."}`;
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Ticket Panel Could Not Be Sent",
          description: message,
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
    });
  }
}