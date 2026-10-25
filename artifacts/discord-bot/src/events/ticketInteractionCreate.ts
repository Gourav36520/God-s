import {
  ChannelType,
  Events,
  PermissionFlagsBits,
} from "discord.js";
import type {
  ButtonInteraction,
  ChannelSelectMenuInteraction,
  Interaction,
  RepliableInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { createGodsEmbed, GODS_EMOJI } from "../commands/ui.js";
import { ticketConfigStore } from "../tickets/config-store.js";
import {
  TICKET_CLOSE_BUTTON_ID,
  TICKET_CREATE_BUTTON_ID,
} from "../tickets/core.js";
import {
  buildTicketConfigPanel,
  buildTicketEmbedPicker,
} from "../tickets/views.js";
import { welcomeGoodbyeStore } from "../welcome-goodbye/config-store.js";
import { ticketService, TicketUserError } from "../tickets/service.js";

export const name = Events.InteractionCreate;
export const once = false;

export async function execute(interaction: Interaction): Promise<void> {
  if (!isTicketComponent(interaction)) return;

  try {
    if (interaction.isButton()) {
      if (interaction.customId === TICKET_CREATE_BUTTON_ID) {
        await handleCreateTicket(interaction);
      } else if (interaction.customId === TICKET_CLOSE_BUTTON_ID) {
        await handleCloseTicket(interaction);
      } else if (interaction.customId.startsWith("ticket:config:")) {
        await handleConfigButton(interaction);
      } else if (interaction.customId.startsWith("ticket:embed:page:")) {
        await handleEmbedPage(interaction);
      }
      return;
    }

    if (interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu()) {
      await handleConfigSelect(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleEmbedSelect(interaction);
    }
  } catch (error) {
    const detail =
      error instanceof TicketUserError
        ? error.message
        : "The Ticket action could not be completed. Check that the bot has access to this server and try again.";
    logger.warn(
      `Ticket interaction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (interaction.isRepliable()) {
      await reportError(interaction, detail);
    }
  }
}

export function isTicketComponent(interaction: Interaction): boolean {
  if (interaction.isButton()) {
    return (
      interaction.customId.startsWith("ticket:") ||
      interaction.customId === TICKET_CREATE_BUTTON_ID ||
      interaction.customId === TICKET_CLOSE_BUTTON_ID
    );
  }
  if (
    interaction.isRoleSelectMenu() ||
    interaction.isChannelSelectMenu() ||
    interaction.isStringSelectMenu()
  ) {
    return interaction.customId.startsWith("ticket:");
  }
  return false;
}

async function handleConfigButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const action = parts[2];
  const guildId = parts[3];
  const ownerId = parts[4];
  if (!(await validateAdminControl(interaction, guildId, ownerId))) return;

  await interaction.deferUpdate();
  if (action !== "toggle" && action !== "save") {
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Ticket Control Expired",
          description: "Run `/ticket config` to open a new configuration panel.",
          emoji: GODS_EMOJI.settings,
          tone: "warning",
        }),
      ],
      components: [],
    });
    return;
  }
  let savedConfig: ReturnType<typeof ticketConfigStore.get>;
  try {
    if (action === "toggle") {
      const current = ticketConfigStore.get(guildId);
      savedConfig = await ticketConfigStore.update(guildId, {
        enabled: !current.enabled,
      });
    } else {
      savedConfig = await ticketConfigStore.save(guildId);
    }
  } catch (error) {
    logger.error(
      `Ticket configuration write failed for guild ${guildId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Ticket Configuration Was Not Saved",
          description:
            "The updated Ticket settings could not be written to the existing guild configuration. Check that the bot data directory is writable, then try again.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
    });
    return;
  }
  await interaction.editReply(
    buildTicketConfigPanel({
      guildId,
      userId: interaction.user.id,
      config: savedConfig,
      panelEmbed: selectedPanelEmbed(guildId),
    }),
  );
}

async function handleConfigSelect(
  interaction: RoleSelectMenuInteraction | ChannelSelectMenuInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const field = parts[2];
  const guildId = parts[3];
  const ownerId = parts[4];
  if (!(await validateAdminControl(interaction, guildId, ownerId))) return;

  if (!interaction.guild) {
    await reportError(interaction, "Ticket configuration can only be changed inside a server.");
    return;
  }
  const selectedId = interaction.values[0];
  if (!selectedId) {
    await reportError(interaction, "Select one value before saving this Ticket setting.");
    return;
  }

  let patch: Parameters<typeof ticketConfigStore.update>[1];
  if (field === "staff" && interaction.isRoleSelectMenu()) {
    const role = await interaction.guild.roles.fetch(selectedId).catch(() => null);
    if (!role) {
      await reportError(interaction, "Staff Role could not be found in this server. Select a valid role.");
      return;
    }
    if (role.id === interaction.guild.roles.everyone.id) {
      await reportError(interaction, "Staff Role cannot be @everyone. Select a separate staff role.");
      return;
    }
    patch = { staffRoleId: role.id };
  } else if (interaction.isChannelSelectMenu()) {
    const channel = await interaction.guild.channels.fetch(selectedId).catch(() => null);
    if (field === "category") {
      if (!channel || channel.type !== ChannelType.GuildCategory) {
        await reportError(interaction, "Ticket Category must be a category channel in this server.");
        return;
      }
      patch = { categoryId: channel.id };
    } else if (field === "transcript") {
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement)
      ) {
        await reportError(interaction, "Transcript/Log Channel must be a text channel in this server.");
        return;
      }
      patch = { transcriptChannelId: channel.id };
    } else if (field === "panel") {
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement)
      ) {
        await reportError(interaction, "Panel Channel must be a text channel in this server.");
        return;
      }
      patch = { panelChannelId: channel.id };
    } else {
      await reportError(interaction, "That Ticket selector is no longer valid. Run `/ticket config` again.");
      return;
    }
  } else {
    await reportError(interaction, "That Ticket selector does not match the selected item.");
    return;
  }

  await interaction.deferUpdate();
  try {
    await ticketConfigStore.update(guildId, patch);
    await interaction.editReply(
      buildTicketConfigPanel({
        guildId,
        userId: interaction.user.id,
        config: ticketConfigStore.get(guildId),
        panelEmbed: selectedPanelEmbed(guildId),
      }),
    );
  } catch (error) {
    logger.error(
      `Ticket configuration write failed for guild ${guildId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Ticket Setting Was Not Saved",
          description:
            "The selected Discord ID could not be written to the existing guild configuration. Check that the bot data directory is writable, then select it again.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
    });
  }
}

async function handleEmbedSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  if (parts[1] !== "embed" || parts[2] !== "select") return;
  const guildId = parts[4];
  const ownerId = parts[5];
  if (!(await validateAdminControl(interaction, guildId, ownerId))) return;

  const embedId = interaction.values[0];
  const savedEmbed = welcomeGoodbyeStore
    .get(guildId)
    .embeds.find((embed) => embed.id === embedId);
  if (!savedEmbed) {
    await reportError(
      interaction,
      "That saved embed is no longer available in this server. Open `/ticket embed` again and choose an existing saved embed.",
    );
    return;
  }

  await interaction.deferUpdate();
  try {
    await ticketConfigStore.update(guildId, { panelEmbedId: savedEmbed.id });
    await interaction.editReply(
      buildTicketEmbedPicker({
        guildId,
        userId: interaction.user.id,
        page: Number(parts[3]) || 0,
        config: welcomeGoodbyeStore.get(guildId),
        selectedEmbedId: ticketConfigStore.get(guildId).panelEmbedId,
      }),
    );
  } catch (error) {
    logger.error(
      `Ticket embed reference could not be saved for guild ${guildId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Ticket Panel Embed Was Not Saved",
          description:
            "The selected saved-embed ID could not be written to the existing guild configuration. Check that the bot data directory is writable, then try again.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
    });
  }
}

async function handleEmbedPage(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split(":");
  const page = Number(parts[3]);
  const guildId = parts[4];
  const ownerId = parts[5];
  if (!Number.isInteger(page) || page < 0) {
    await reportError(interaction, "That saved-embed page is no longer valid. Run `/ticket embed` again.");
    return;
  }
  if (!(await validateAdminControl(interaction, guildId, ownerId))) return;
  await interaction.update(
    buildTicketEmbedPicker({
      guildId,
      userId: interaction.user.id,
      page,
      config: welcomeGoodbyeStore.get(guildId),
      selectedEmbedId: ticketConfigStore.get(guildId).panelEmbedId,
    }),
  );
}

async function handleCreateTicket(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await reportError(interaction, "Tickets can only be created inside a server.");
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const opener = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  if (!opener) {
    await reportError(interaction, "I could not verify your server membership. Rejoin the server and try again.");
    return;
  }

  try {
    const result = await ticketService.createTicket(interaction.guild, opener);
    const prefix = result.alreadyOpen
      ? "You already have an open ticket:"
      : "Your ticket was created:";
    await interaction.editReply({
      content: `${prefix} <#${result.channel.id}>`,
    });
  } catch (error) {
    const message =
      error instanceof TicketUserError
        ? error.message
        : "The ticket could not be created. Check the bot's permissions in the configured Ticket Category and try again.";
    await reportError(interaction, message);
  }
}

async function handleCloseTicket(
  interaction: ButtonInteraction,
): Promise<void> {
  if (
    !interaction.guild ||
    !interaction.channel ||
    interaction.channel.type !== ChannelType.GuildText
  ) {
    await reportError(interaction, "Close Ticket can only be used inside a ticket text channel.");
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await ticketService.closeTicket(
      interaction.channel,
      interaction.guild,
      interaction.user.id,
    );
    let messageWarning = "";
    try {
      await interaction.message.edit({
        embeds: [
          createGodsEmbed({
            title: "Ticket Closed",
            description: `This ticket was closed by <@${interaction.user.id}>. The opener can still read the channel but can no longer send messages.`,
            tone: "warning",
          }),
        ],
        components: [],
      });
    } catch (error) {
      messageWarning =
        " The ticket is closed, but I could not remove the Close Ticket button from the original message.";
      logger.warn(
        `Closed ticket ${interaction.channel.id}, but could not update its button message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await interaction.editReply({
      content: result.logWarning
        ? `Ticket closed. ${result.logWarning}${messageWarning}`
        : `Ticket closed. The opener can still read this channel but cannot send messages.${messageWarning}`,
    });
  } catch (error) {
    const message =
      error instanceof TicketUserError
        ? error.message
        : "The ticket could not be closed. Check the bot's Manage Channels permission and try again.";
    await reportError(interaction, message);
  }
}

async function validateAdminControl(
  interaction: RepliableInteraction,
  expectedGuildId: string | undefined,
  ownerId: string | undefined,
): Promise<boolean> {
  if (!interaction.guildId || !expectedGuildId || interaction.guildId !== expectedGuildId) {
    await reportError(interaction, "This Ticket control belongs to a different server. Run the command again in this server.");
    return false;
  }
  if (!ownerId || interaction.user.id !== ownerId) {
    await reportError(interaction, "This Ticket control belongs to another administrator's session.");
    return false;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await reportError(interaction, "Only a server Administrator can change Ticket configuration.");
    return false;
  }
  return true;
}

function selectedPanelEmbed(guildId: string) {
  const config = ticketConfigStore.get(guildId);
  return config.panelEmbedId
    ? welcomeGoodbyeStore
        .get(guildId)
        .embeds.find((embed) => embed.id === config.panelEmbedId)
    : undefined;
}

async function reportError(
  interaction: RepliableInteraction,
  message: string,
): Promise<void> {
  const payload = {
    embeds: [
      createGodsEmbed({
        title: "Ticket Action Needs Attention",
        description: message,
        emoji: GODS_EMOJI.settings,
        tone: "error" as const,
      }),
    ],
    ephemeral: true,
  };
  try {
    if (interaction.deferred) {
      await interaction.editReply(payload);
    } else if (interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    logger.warn(
      `Could not report a Ticket error to the user: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}