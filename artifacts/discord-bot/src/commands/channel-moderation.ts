import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  Message,
  TextChannel,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { securityManager } from "../lib/registry.js";
import type {
  ChannelLockSnapshot,
  ChannelPermissionState,
} from "../security/types.js";
import {
  deny,
  requireAdminManagerOrOwner,
  resolveModerationContext,
} from "../moderation/permissions.js";
import type { ModerationContext } from "../moderation/permissions.js";

const LOCKED_PERMISSIONS = [
  ["sendMessages", PermissionFlagsBits.SendMessages],
  ["sendMessagesInThreads", PermissionFlagsBits.SendMessagesInThreads],
  ["createPublicThreads", PermissionFlagsBits.CreatePublicThreads],
  ["createPrivateThreads", PermissionFlagsBits.CreatePrivateThreads],
] as const;

const PURGE_AGE_LIMIT_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_PURGE_COUNT = 1_000;

function currentPermissionState(
  channel: TextChannel,
  guildId: string,
  permission: bigint,
): ChannelPermissionState {
  const overwrite = channel.permissionOverwrites.cache.get(guildId);
  if (overwrite?.deny.has(permission)) return "deny";
  if (overwrite?.allow.has(permission)) return "allow";
  return "inherit";
}

function snapshotChannelPermissions(
  channel: TextChannel,
  guildId: string,
): ChannelLockSnapshot {
  return {
    sendMessages: currentPermissionState(
      channel,
      guildId,
      PermissionFlagsBits.SendMessages,
    ),
    sendMessagesInThreads: currentPermissionState(
      channel,
      guildId,
      PermissionFlagsBits.SendMessagesInThreads,
    ),
    createPublicThreads: currentPermissionState(
      channel,
      guildId,
      PermissionFlagsBits.CreatePublicThreads,
    ),
    createPrivateThreads: currentPermissionState(
      channel,
      guildId,
      PermissionFlagsBits.CreatePrivateThreads,
    ),
  };
}

function restoreValue(state: ChannelPermissionState): boolean | null {
  if (state === "allow") return true;
  if (state === "deny") return false;
  return null;
}

function getCurrentTextChannel(
  interaction: ChatInputCommandInteraction,
): TextChannel | null {
  const channel = interaction.channel;
  if (
    !channel ||
    !channel.isTextBased() ||
    !("permissionOverwrites" in channel) ||
    !("messages" in channel)
  ) {
    return null;
  }
  return channel as TextChannel;
}

export const lock = {
  data: new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock the current text channel"),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = await resolveModerationContext(interaction);
    if (!context || !(await requireAdminManagerOrOwner(interaction, context))) return;
    const channel = getCurrentTextChannel(interaction);
    if (!channel) {
      await deny(interaction, "Use this command in a server text channel.");
      return;
    }
    if (
      !context.bot
        .permissionsIn(channel)
        .has(PermissionFlagsBits.ManageRoles)
    ) {
      await deny(interaction, "The bot needs Manage Roles in this channel to lock it.");
      return;
    }

    const config = securityManager.getConfig(context.guild.id);
    const existingSnapshot = config.lockedChannels[channel.id];
    const snapshot =
      existingSnapshot ?? snapshotChannelPermissions(channel, context.guild.id);
    if (!existingSnapshot) {
      await securityManager.updateConfig(context.guild.id, {
        lockedChannels: {
          ...config.lockedChannels,
          [channel.id]: snapshot,
        },
      });
    }

    try {
      await channel.permissionOverwrites.edit(
        context.guild.roles.everyone,
        {
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
        },
        { reason: `Channel locked by ${interaction.user.tag} (${interaction.user.id})` },
      );
    } catch {
      if (!existingSnapshot) {
        const latest = securityManager.getConfig(context.guild.id);
        const lockedChannels = { ...latest.lockedChannels };
        delete lockedChannels[channel.id];
        await securityManager
          .updateConfig(context.guild.id, { lockedChannels })
          .catch((error: unknown) =>
            logger.error(
              `Failed to remove unused lock snapshot guild=${context.guild.id} channel=${channel.id}:`,
              error,
            ),
          );
      }
      await deny(interaction, "The channel could not be locked. Check the bot's channel permissions.");
      return;
    }

    logger.info(
      `Channel locked guild=${context.guild.id} channel=${channel.id} actor=${context.actor.id}`,
    );
    await interaction.reply({ content: `${channel} is locked.`, ephemeral: true });
  },
};

export const unlock = {
  data: new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Restore the current channel's previous lock permissions"),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = await resolveModerationContext(interaction);
    if (!context || !(await requireAdminManagerOrOwner(interaction, context))) return;
    const channel = getCurrentTextChannel(interaction);
    if (!channel) {
      await deny(interaction, "Use this command in a server text channel.");
      return;
    }
    if (
      !context.bot
        .permissionsIn(channel)
        .has(PermissionFlagsBits.ManageRoles)
    ) {
      await deny(interaction, "The bot needs Manage Roles in this channel to unlock it.");
      return;
    }

    const config = securityManager.getConfig(context.guild.id);
    const snapshot = config.lockedChannels[channel.id];
    if (!snapshot) {
      await deny(interaction, "There is no saved lock state for this channel.");
      return;
    }

    try {
      await channel.permissionOverwrites.edit(
        context.guild.roles.everyone,
        {
          SendMessages: restoreValue(snapshot.sendMessages),
          SendMessagesInThreads: restoreValue(snapshot.sendMessagesInThreads),
          CreatePublicThreads: restoreValue(snapshot.createPublicThreads),
          CreatePrivateThreads: restoreValue(snapshot.createPrivateThreads),
        },
        { reason: `Channel unlocked by ${interaction.user.tag} (${interaction.user.id})` },
      );
    } catch {
      await deny(interaction, "The channel could not be unlocked. Check the bot's channel permissions.");
      return;
    }

    const lockedChannels = { ...config.lockedChannels };
    delete lockedChannels[channel.id];
    await securityManager.updateConfig(context.guild.id, { lockedChannels });
    logger.info(
      `Channel unlocked guild=${context.guild.id} channel=${channel.id} actor=${context.actor.id}`,
    );
    await interaction.reply({
      content: `${channel} has been restored to its previous send permissions.`,
      ephemeral: true,
    });
  },
};

export const purge = {
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete eligible messages from the current channel")
    .addStringOption((option) =>
      option
        .setName("amount")
        .setDescription(`A number from 1 to ${MAX_PURGE_COUNT}, or all`)
        .setMinLength(1)
        .setMaxLength(4)
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = await resolveModerationContext(interaction);
    if (!context || !(await requireAdminManagerOrOwner(interaction, context))) return;
    const channel = getCurrentTextChannel(interaction);
    if (!channel) {
      await deny(interaction, "Use this command in a server text channel.");
      return;
    }
    const permissions = context.bot.permissionsIn(channel);
    if (!permissions.has(PermissionFlagsBits.ManageMessages)) {
      await deny(interaction, "The bot needs Manage Messages in this channel to purge.");
      return;
    }

    const rawAmount = interaction.options.getString("amount", true).trim().toLowerCase();
    if (rawAmount === "all") {
      await confirmPurgeAll(interaction, channel, context);
      return;
    }
    if (!/^\d{1,4}$/.test(rawAmount)) {
      await deny(interaction, `Enter a number from 1 to ${MAX_PURGE_COUNT}, or use all.`);
      return;
    }
    const amount = Number(rawAmount);
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_PURGE_COUNT) {
      await deny(interaction, `Enter a number from 1 to ${MAX_PURGE_COUNT}, or use all.`);
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const deleted = await deleteEligibleMessages(channel, amount);
      logger.info(
        `Messages purged guild=${context.guild.id} channel=${channel.id} deleted=${deleted} actor=${interaction.user.id}`,
      );
      await interaction.editReply(
        `Deleted ${deleted} eligible message${deleted === 1 ? "" : "s"}. Messages older than 14 days are not eligible for bulk deletion.`,
      );
    } catch (error) {
      logger.error(
        `Purge failed guild=${context.guild.id} channel=${channel.id}:`,
        error,
      );
      await interaction.editReply(
        "Purge stopped because Discord rejected a deletion. Any messages already deleted remain deleted.",
      );
    }
  },
};

async function confirmPurgeAll(
  interaction: ChatInputCommandInteraction,
  channel: TextChannel,
  context: ModerationContext,
): Promise<void> {
  const confirmId = `purge:confirm:${interaction.id}`;
  const cancelId = `purge:cancel:${interaction.id}`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel("Delete eligible messages")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({
    content: "This will delete all eligible messages in the current channel. Confirm to continue.",
    components: [row],
    ephemeral: true,
  });
  const message = (await interaction.fetchReply()) as Message;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30_000,
  });
  let handled = false;

  collector.on("collect", async (button) => {
    if (button.user.id !== interaction.user.id) {
      await button.reply({
        content: "Only the person who started this purge can confirm it.",
        ephemeral: true,
      });
      return;
    }
    if (handled) return;
    handled = true;
    collector.stop("handled");

    if (button.customId === cancelId) {
      await button.deferUpdate();
      await interaction.editReply({
        content: "Purge cancelled. No messages were deleted.",
        components: [],
      });
      return;
    }

    const rolesFetched = await context.guild.roles.fetch().catch(() => null);
    const [actor, bot, refreshedChannel] = await Promise.all([
      context.guild.members
        .fetch({ user: interaction.user.id, force: true })
        .catch(() => null),
      context.guild.members.fetchMe().catch(() => null),
      context.guild.channels.fetch(channel.id).catch(() => null),
    ]);
    let authorized = Boolean(actor && bot && rolesFetched && refreshedChannel);
    if (authorized && actor && bot && refreshedChannel) {
      authorized = context.guild.ownerId === actor.id;
      if (!authorized) {
        const config = securityManager.getConfig(context.guild.id);
        for (const roleId of [config.adminRoleId, config.managerRoleId]) {
          if (typeof roleId !== "string" || roleId.length === 0) continue;
          const role = await context.guild.roles.fetch(roleId).catch(() => null);
          if (role && actor.roles.cache.has(role.id)) {
            authorized = true;
            break;
          }
        }
      }
      authorized =
        authorized &&
        refreshedChannel.isTextBased() &&
        "messages" in refreshedChannel &&
        bot.permissionsIn(refreshedChannel).has(PermissionFlagsBits.ManageMessages);
    }
    if (
      !authorized ||
      !bot ||
      !refreshedChannel ||
      !refreshedChannel.isTextBased() ||
      !("messages" in refreshedChannel)
    ) {
      await button.update({
        content: "Your access or the bot's channel permissions changed. No messages were deleted.",
        components: [],
      });
      return;
    }

    const purgeChannel = refreshedChannel as TextChannel;
    await button.deferUpdate();
    await interaction.editReply({
      content: "Deleting eligible messages…",
      components: [],
    });
    try {
      const deleted = await deleteEligibleMessages(purgeChannel, null);
      logger.info(
        `All eligible messages purged guild=${context.guild.id} channel=${channel.id} deleted=${deleted} actor=${interaction.user.id}`,
      );
      await interaction.editReply({
        content: `Deleted ${deleted} eligible message${deleted === 1 ? "" : "s"}. Messages older than 14 days were skipped.`,
        components: [],
      });
    } catch (error) {
      logger.error(
        `Purge-all failed guild=${context.guild.id} channel=${channel.id}:`,
        error,
      );
      await interaction.editReply({
        content: "Purge stopped because Discord rejected a deletion. Messages already deleted remain deleted.",
        components: [],
      });
    }
  });

  collector.on("end", async (_collected, reason) => {
    if (reason === "time" && !handled) {
      handled = true;
      await interaction
        .editReply({
          content: "Confirmation expired. No messages were deleted.",
          components: [],
        })
        .catch(() => null);
    }
  });
}

async function deleteEligibleMessages(
  channel: TextChannel,
  requestedCount: number | null,
): Promise<number> {
  let deleted = 0;
  let before: string | undefined;
  const cutoff = Date.now() - PURGE_AGE_LIMIT_MS;

  while (requestedCount === null || deleted < requestedCount) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (batch.size === 0) break;
    const oldest = batch.last();
    if (!oldest) break;
    before = oldest.id;

    const remaining =
      requestedCount === null ? Number.POSITIVE_INFINITY : requestedCount - deleted;
    const eligible = Array.from(batch.values())
      .filter((message) => message.createdTimestamp > cutoff && message.deletable)
      .slice(0, remaining);

    if (eligible.length === 1) {
      await eligible[0].delete();
      deleted += 1;
    } else if (eligible.length > 1) {
      const removed = await channel.bulkDelete(
        eligible.map((message) => message.id),
        true,
      );
      deleted += removed.size;
    }

    if (batch.size < 100) break;
  }
  return deleted;
}
