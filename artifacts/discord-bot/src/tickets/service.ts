import {
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import type { Guild, GuildMember, TextChannel } from "discord.js";
import { logger } from "../lib/logger.js";
import { createGodsEmbed } from "../commands/ui.js";
import { ticketConfigStore } from "./config-store.js";
import {
  buildTicketPermissionOverwrites,
  buildTicketTopic,
  findOpenTicketForOpener,
  parseTicketTopic,
} from "./core.js";
import type { TicketConfig } from "../security/types.js";
import { buildTicketCloseButtonRow } from "./views.js";

export class TicketUserError extends Error {}

function ticketChannelName(username: string): string {
  const safeName =
    username
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 84) || "member";
  return `ticket-${safeName}`;
}

async function getBotMember(guild: Guild): Promise<GuildMember> {
  try {
    return guild.members.me ?? (await guild.members.fetchMe());
  } catch {
    throw new TicketUserError(
      "I could not verify my server permissions. Confirm that the bot is still a member of this server, then try again.",
    );
  }
}

function requireCreateConfig(config: TicketConfig): void {
  if (!config.enabled) {
    throw new TicketUserError("Ticket System is disabled. Enable it with `/ticket config`.");
  }
  if (!config.staffRoleId) {
    throw new TicketUserError("Staff Role is missing. Select it with `/ticket config`.");
  }
  if (!config.categoryId) {
    throw new TicketUserError("Ticket Category is missing. Select it with `/ticket config`.");
  }
}

export class TicketService {
  private readonly pendingCreates = new Map<
    string,
    Promise<{ channel: TextChannel; alreadyOpen: boolean }>
  >();

  async createTicket(
    guild: Guild,
    opener: GuildMember,
  ): Promise<{ channel: TextChannel; alreadyOpen: boolean }> {
    const key = `${guild.id}:${opener.id}`;
    const pending = this.pendingCreates.get(key);
    if (pending) {
      const result = await pending;
      return { ...result, alreadyOpen: true };
    }

    const creating = this.createTicketOnce(guild, opener);
    this.pendingCreates.set(key, creating);
    try {
      return await creating;
    } finally {
      if (this.pendingCreates.get(key) === creating) {
        this.pendingCreates.delete(key);
      }
    }
  }

  private async createTicketOnce(
    guild: Guild,
    opener: GuildMember,
  ): Promise<{ channel: TextChannel; alreadyOpen: boolean }> {
    const config = ticketConfigStore.get(guild.id);
    requireCreateConfig(config);

    const staffRole = await guild.roles.fetch(config.staffRoleId!);
    if (!staffRole) {
      throw new TicketUserError(
        "Staff Role no longer exists. Select a valid role with `/ticket config`.",
      );
    }
    if (staffRole.id === guild.roles.everyone.id) {
      throw new TicketUserError(
        "Staff Role cannot be @everyone. Select a separate staff role with `/ticket config`.",
      );
    }

    const category = await guild.channels.fetch(config.categoryId!);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new TicketUserError(
        "Ticket Category no longer exists or is not a category. Select a valid category with `/ticket config`.",
      );
    }

    let channels;
    try {
      channels = await guild.channels.fetch();
    } catch {
      throw new TicketUserError(
        "I could not check existing ticket channels, so I cannot safely prevent a duplicate. Check the bot's server access and try again.",
      );
    }
    if (!channels) {
      throw new TicketUserError(
        "I could not load the server's channels, so I cannot safely prevent a duplicate. Try again.",
      );
    }
    const existing = findOpenTicketForOpener(
      [...channels.values()].filter(
        (channel): channel is TextChannel =>
          channel !== null && channel.type === ChannelType.GuildText,
      ),
      guild.id,
      opener.id,
    );
    if (existing) {
      return {
        channel: existing as TextChannel,
        alreadyOpen: true,
      };
    }

    const botMember = await getBotMember(guild);
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new TicketUserError(
        "I need the Manage Channels permission to create private ticket channels.",
      );
    }
    const categoryPermissions = category.permissionsFor(botMember);
    if (
      !categoryPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ])
    ) {
      throw new TicketUserError(
        "I need View Channel and Send Messages access in the Ticket Category to create and greet tickets.",
      );
    }

    let channel: TextChannel;
    try {
      channel = (await guild.channels.create({
        name: ticketChannelName(opener.user.username),
        type: ChannelType.GuildText,
        parent: category.id,
        topic: buildTicketTopic(guild.id, opener.id),
        permissionOverwrites: buildTicketPermissionOverwrites({
          everyoneRoleId: guild.roles.everyone.id,
          openerId: opener.id,
          staffRoleId: staffRole.id,
          botUserId: botMember.id,
        }),
        reason: `Ticket opened by ${opener.user.tag} (${opener.id})`,
      })) as TextChannel;
    } catch (error) {
      throw new TicketUserError(
        this.describeDiscordError(
          error,
          "I could not create the ticket channel. Confirm the bot can manage channels under the selected category.",
        ),
      );
    }

    try {
      await channel.send({
        content: `Welcome <@${opener.id}> — <@&${staffRole.id}> will assist you here.`,
        embeds: [
          createGodsEmbed({
            title: "Ticket Created",
            description:
              "Describe what you need help with. A staff member will reply here.",
            tone: "info",
          }),
        ],
        components: [buildTicketCloseButtonRow()],
        allowedMentions: {
          users: [opener.id],
          roles: [staffRole.id],
          parse: [],
        },
      });
    } catch (error) {
      let cleanupWarning = "";
      try {
        await channel.delete("Ticket setup failed after channel creation");
      } catch (cleanupError) {
        cleanupWarning = ` The partially created channel <#${channel.id}> could not be removed; delete it manually after checking its permissions.`;
        logger.error(
          `Ticket setup cleanup failed for channel ${channel.id}: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
      throw new TicketUserError(
        this.describeDiscordError(
          error,
          `The ticket channel was created, but I could not send its welcome message. Check the bot's channel permissions and try again.${cleanupWarning}`,
        ),
      );
    }

    return { channel, alreadyOpen: false };
  }

  async closeTicket(
    channel: TextChannel,
    guild: Guild,
    actorId: string,
  ): Promise<{ openerId: string; logWarning: string | null }> {
    const metadata = parseTicketTopic(channel.topic);
    if (!metadata || metadata.guildId !== guild.id) {
      throw new TicketUserError(
        "This channel has no valid GOD'S ticket metadata, so it cannot be closed with this control.",
      );
    }
    if (metadata.status === "closed") {
      throw new TicketUserError("This ticket is already closed.");
    }

    let actor: GuildMember;
    try {
      actor = await guild.members.fetch(actorId);
    } catch {
      throw new TicketUserError(
        "I could not verify your current server roles. Rejoin the server and try again.",
      );
    }
    const staffRoleId = ticketConfigStore.get(guild.id).staffRoleId;
    const canClose =
      actor.id === metadata.openerId ||
      actor.permissions.has(PermissionFlagsBits.Administrator) ||
      (!!staffRoleId && actor.roles.cache.has(staffRoleId));
    if (!canClose) {
      throw new TicketUserError(
        "Only the ticket opener, a member of the configured Staff Role, or a server Administrator can close this ticket.",
      );
    }

    await channel.setTopic(
      buildTicketTopic(guild.id, metadata.openerId, "closed"),
      `Ticket closed by ${actor.user.tag} (${actor.id})`,
    );
    try {
      await channel.permissionOverwrites.edit(
        metadata.openerId,
        { SendMessages: false },
        { reason: `Ticket closed by ${actor.user.tag} (${actor.id})` },
      );
    } catch (error) {
      let metadataRollbackFailed = false;
      try {
        await channel.setTopic(
          buildTicketTopic(guild.id, metadata.openerId, "open"),
          "Reopened ticket metadata after close permission update failed",
        );
      } catch (rollbackError) {
        metadataRollbackFailed = true;
        logger.error(
          `Ticket metadata rollback failed for channel ${channel.id}: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        );
      }
      const fallback = metadataRollbackFailed
        ? "Ticket close permissions could not be updated, and ticket metadata could not be restored. An Administrator should review this channel's topic and opener permissions."
        : "The ticket status could not be updated. Check the bot's Manage Channels permission and try again.";
      throw new TicketUserError(
        metadataRollbackFailed
          ? fallback
          : this.describeDiscordError(error, fallback),
      );
    }

    const config = ticketConfigStore.get(guild.id);
    const logWarning = await this.sendCloseLog(
      guild,
      config.transcriptChannelId,
      channel,
      metadata.openerId,
      actorId,
    );
    return { openerId: metadata.openerId, logWarning };
  }

  private async sendCloseLog(
    guild: Guild,
    channelId: string | null,
    ticketChannel: TextChannel,
    openerId: string,
    closedById: string,
  ): Promise<string | null> {
    if (!channelId) return null;
    try {
      const channel = await guild.channels.fetch(channelId);
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement)
      ) {
        return "Transcript/Log Channel is no longer a text channel; the ticket was closed but no log message was sent.";
      }
      await channel.send({
        embeds: [
          createGodsEmbed({
            title: "Ticket Closed",
            description: [
              `**Ticket:** <#${ticketChannel.id}>`,
              `**Opened by:** <@${openerId}>`,
              `**Closed by:** <@${closedById}>`,
              "",
              "Transcript export is not part of this stage.",
            ].join("\n"),
            tone: "warning",
          }),
        ],
        allowedMentions: { parse: [] },
      });
      return null;
    } catch (error) {
      logger.warn(
        `Ticket close log could not be sent to ${channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "The ticket was closed, but I could not send its log. Check the Transcript/Log Channel and bot permissions.";
    }
  }

  private describeDiscordError(error: unknown, fallback: string): string {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 50013) {
      return "Missing Permissions: grant the bot Manage Channels and the required view/send permissions for the configured ticket category.";
    }
    if (code === 50001) {
      return "Missing Access: grant the bot access to the configured ticket category or channel.";
    }
    if (error instanceof Error && error.message) {
      return `${fallback} Discord reported: ${error.message}`;
    }
    return fallback;
  }
}

export const ticketService = new TicketService();