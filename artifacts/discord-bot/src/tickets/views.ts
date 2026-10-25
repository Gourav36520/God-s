import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type {
  SavedWelcomeGoodbyeEmbed,
  WelcomeGoodbyeGuildConfig,
} from "../welcome-goodbye/types.js";
import type { TicketConfig } from "../security/types.js";
import { createGodsEmbed, GODS_EMOJI } from "../commands/ui.js";
import { TICKET_CREATE_BUTTON_ID, TICKET_CLOSE_BUTTON_ID } from "./core.js";

export function buildTicketConfigPanel(options: {
  guildId: string;
  userId: string;
  config: TicketConfig;
  panelEmbed?: SavedWelcomeGoodbyeEmbed;
}) {
  const { guildId, userId, config, panelEmbed } = options;
  const description = [
    `**Status:** ${config.enabled ? "Enabled" : "Disabled"}`,
    `**Staff Role:** ${config.staffRoleId ? `<@&${config.staffRoleId}>` : "Not selected"}`,
    `**Ticket Category:** ${config.categoryId ? `<#${config.categoryId}>` : "Not selected"}`,
    `**Transcript/Log Channel:** ${config.transcriptChannelId ? `<#${config.transcriptChannelId}>` : "Not selected"}`,
    `**Panel Channel:** ${config.panelChannelId ? `<#${config.panelChannelId}>` : "Not selected"}`,
    `**Panel Embed:** ${panelEmbed ? panelEmbed.name : config.panelEmbedId ? "Selected embed is missing" : "Not selected"}`,
    "",
    "Selections are saved immediately to this server's existing guild configuration. Use Save to confirm and read back the saved settings.",
  ].join("\n");

  const staffRole = new RoleSelectMenuBuilder()
    .setCustomId(`ticket:config:staff:${guildId}:${userId}`)
    .setPlaceholder("Select the staff role");
  const category = new ChannelSelectMenuBuilder()
    .setCustomId(`ticket:config:category:${guildId}:${userId}`)
    .setPlaceholder("Select the ticket category")
    .setChannelTypes(ChannelType.GuildCategory);
  const transcript = new ChannelSelectMenuBuilder()
    .setCustomId(`ticket:config:transcript:${guildId}:${userId}`)
    .setPlaceholder("Select the transcript/log channel")
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  const panel = new ChannelSelectMenuBuilder()
    .setCustomId(`ticket:config:panel:${guildId}:${userId}`)
    .setPlaceholder("Select the ticket panel channel")
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  const toggle = new ButtonBuilder()
    .setCustomId(`ticket:config:toggle:${guildId}:${userId}`)
    .setLabel(config.enabled ? "Disable Tickets" : "Enable Tickets")
    .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const save = new ButtonBuilder()
    .setCustomId(`ticket:config:save:${guildId}:${userId}`)
    .setLabel("Save")
    .setStyle(ButtonStyle.Primary);

  return {
    embeds: [
      createGodsEmbed({
        title: "Ticket Configuration",
        description,
        emoji: GODS_EMOJI.settings,
        tone: "info",
      }),
    ],
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(staffRole),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(category),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(transcript),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(panel),
      new ActionRowBuilder<ButtonBuilder>().addComponents(toggle, save),
    ],
  };
}

export function buildTicketEmbedPicker(options: {
  guildId: string;
  userId: string;
  page: number;
  config: WelcomeGoodbyeGuildConfig;
  selectedEmbedId: string | null;
}) {
  const { guildId, userId, config, selectedEmbedId } = options;
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(config.embeds.length / pageSize));
  const page = Math.min(Math.max(0, options.page), pageCount - 1);
  const embeds = config.embeds.slice(page * pageSize, (page + 1) * pageSize);

  if (config.embeds.length === 0) {
    return {
      embeds: [
        createGodsEmbed({
          title: "Ticket Panel Embed",
          description: "No saved embeds exist for this server. Create and save one with `/create embed`, then run `/ticket embed` again.",
          emoji: GODS_EMOJI.settings,
          tone: "warning",
        }),
      ],
      components: [],
    };
  }

  const selector = new StringSelectMenuBuilder()
    .setCustomId(`ticket:embed:select:${page}:${guildId}:${userId}`)
    .setPlaceholder("Choose a saved embed for the ticket panel")
    .addOptions(
      embeds.map((embed) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(embed.name.slice(0, 100))
          .setValue(embed.id)
          .setDescription(
            (embed.definition.title ||
              embed.definition.description ||
              "Saved server embed").slice(0, 100),
          );
        if (embed.id === selectedEmbedId) option.setDefault(true);
        return option;
      }),
    );
  const components: Array<
    ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
  > = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)];

  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket:embed:page:${page - 1}:${guildId}:${userId}`)
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`ticket:embed:page:${page + 1}:${guildId}:${userId}`)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= pageCount - 1),
      ),
    );
  }

  const selected = selectedEmbedId
    ? config.embeds.find((embed) => embed.id === selectedEmbedId)
    : undefined;
  return {
    embeds: [
      createGodsEmbed({
        title: "Ticket Panel Embed",
        description: [
          "Choose one of this server's existing saved embeds. Ticket settings store only its saved-embed ID.",
          selected ? `\nCurrently selected: **${selected.name}**` : "",
          pageCount > 1 ? `\nPage ${page + 1} of ${pageCount}` : "",
        ].join(""),
        emoji: GODS_EMOJI.settings,
        tone: "info",
      }),
    ],
    components,
  };
}

export function buildTicketPanelButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CREATE_BUTTON_ID)
      .setLabel("Create Ticket")
      .setStyle(ButtonStyle.Success),
  );
}

export function buildTicketCloseButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_BUTTON_ID)
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger),
  );
}