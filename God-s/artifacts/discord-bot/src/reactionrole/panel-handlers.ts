import {
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
} from "discord.js";
import { logger } from "../lib/logger.js";
import {
  botHadReaction,
  checkBotChannelPermissions,
  getReactionRoleAssignmentCount,
  getReactionRolePanels,
  REACTION_ROLE_EMOJI,
  removeBotReaction,
  resolveManageableRole,
  resolveReactionRoleChannel,
  updateReactionRoleConfig,
} from "./service.js";
import type { ReactionRoleMapping, ReactionRolePanel } from "./types.js";
import {
  assertPanelEmbedFits,
  buildPanelEmbed,
  describeReactionFailure,
  describeSendFailure,
  editNotice,
  fetchPanelMessage,
  findPanel,
  LIST_BUTTON_PREFIX,
  panelListView,
  PANELS_PER_PAGE,
  ReactionRoleCommandError,
  removeMappingFromConfig,
  requireEmoji,
  requireMessageId,
} from "./panel-support.js";
import { GOLDEN_ARROW, createGodsEmbed } from "../commands/ui.js";

const panelOperationQueues = new Map<string, Promise<void>>();

export function isReactionRoleListButton(customId: string): boolean {
  return customId.startsWith(LIST_BUTTON_PREFIX);
}

export async function handleReactionRoleListButton(
  interaction: ButtonInteraction,
): Promise<void> {
  try {
    const parts = interaction.customId.slice(LIST_BUTTON_PREFIX.length).split(":");
    const [expectedGuildId, expectedUserId, requestedPage] = parts;
    if (
      !interaction.guildId ||
      interaction.guildId !== expectedGuildId ||
      interaction.user.id !== expectedUserId
    ) {
      await interaction.reply({
        content: "This Reaction Role list belongs to another administrator.",
        ephemeral: true,
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Manage Server permission is required to view this list.",
        ephemeral: true,
      });
      return;
    }

    const page = Number.parseInt(requestedPage ?? "", 10);
    const panels = getReactionRolePanels(interaction.guildId);
    const pageCount = Math.max(1, Math.ceil(panels.length / PANELS_PER_PAGE));
    const safePage = Number.isInteger(page)
      ? Math.min(Math.max(page, 0), pageCount - 1)
      : 0;
    await interaction.update(
      panelListView(panels, interaction.guildId, interaction.user.id, safePage),
    );
  } catch (error) {
    logger.warn(
      "[REACTION ROLE] Could not update panel-list controls:",
      error instanceof Error ? error.message : error,
    );
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "This panel list expired. Run `/reactionrole list` again.",
          ephemeral: true,
        })
        .catch(() => null);
    }
  }
}

export async function createPanel(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): Promise<void> {
  const selectedChannel = interaction.options.getChannel("channel", true);
  const channel = await resolveReactionRoleChannel(guild, selectedChannel.id);
  if (!channel) {
    throw new ReactionRoleCommandError(
      "Invalid Channel",
      "Choose an available text or announcement channel in this server.",
    );
  }
  const permissionError = await checkBotChannelPermissions(
    guild,
    channel,
    [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ],
    "create a Reaction Role panel",
  );
  if (permissionError) {
    throw new ReactionRoleCommandError("Channel Permissions Required", permissionError);
  }

  const panel: ReactionRolePanel = {
    channelId: channel.id,
    messageId: "",
    title: interaction.options.getString("title")?.trim() || "Reaction Roles",
    description:
      interaction.options.getString("description")?.trim() ||
      "React to this panel to choose a server role. You can hold one Reaction Role at a time.",
    createdByBot: true,
    mappings: [],
  };
  assertPanelEmbedFits(panel);

  let message: Message;
  try {
    message = await channel.send({ embeds: [buildPanelEmbed(panel)] });
  } catch {
    throw new ReactionRoleCommandError(
      "Panel Could Not Be Sent",
      describeSendFailure(channel.id),
    );
  }

  const savedPanel = { ...panel, messageId: message.id };
  try {
    await updateReactionRoleConfig(guild.id, (current) => {
      if (current.reactionRolePanels.some((entry) => entry.messageId === message.id)) {
        throw new ReactionRoleCommandError(
          "Panel Already Registered",
          "This message is already configured as a Reaction Role panel.",
        );
      }
      return {
        reactionRolePanels: [...current.reactionRolePanels, savedPanel],
      };
    });
  } catch (error) {
    await message.delete().catch(() => null);
    if (error instanceof ReactionRoleCommandError) throw error;
    throw new ReactionRoleCommandError(
      "Configuration Could Not Be Saved",
      "The panel message was removed because its configuration could not be saved.",
    );
  }

  await editNotice(
    interaction,
    "Reaction Role Panel Created",
    `${GOLDEN_ARROW} Channel: <#${channel.id}>\n${GOLDEN_ARROW} Message ID: \`${message.id}\`\n${GOLDEN_ARROW} Add role mappings with \`/reactionrole add\`.`,
    "success",
  );
}

export async function addMapping(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): Promise<void> {
  const messageId = requireMessageId(interaction);
  const panel = findPanel(guild.id, messageId);
  if (!panel) {
    throw new ReactionRoleCommandError(
      "Panel Not Found",
      "That message is not a configured Reaction Role panel. Use `/reactionrole create` or `/reactionrole assign` first.",
    );
  }
  const emoji = requireEmoji(interaction.options.getString("emoji", true));
  if (panel.mappings.some((mapping) => mapping.emojiKey === emoji.key)) {
    throw new ReactionRoleCommandError(
      "Duplicate Mapping",
      "That emoji already has a mapping on this panel.",
    );
  }
  const selectedRole = interaction.options.getRole("role", true);
  const roleResult = await resolveManageableRole(guild, selectedRole.id);
  if (!roleResult.role) {
    throw new ReactionRoleCommandError(
      "Role Cannot Be Managed",
      roleResult.error ?? "Choose another role.",
    );
  }

  const { channel, message } = await fetchPanelMessage(guild, panel);
  if (!channel || !message) {
    throw new ReactionRoleCommandError(
      "Panel Message Unavailable",
      "The panel channel or message was deleted or is inaccessible. Its configuration was not changed.",
    );
  }
  const permissionError = await checkBotChannelPermissions(
    guild,
    channel,
    [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AddReactions,
    ],
    "add a Reaction Role mapping",
  );
  if (permissionError) {
    throw new ReactionRoleCommandError("Channel Permissions Required", permissionError);
  }

  const mapping: ReactionRoleMapping = {
    emoji: emoji.display,
    emojiKey: emoji.key,
    roleId: roleResult.role.id,
  };
  const botUserId = interaction.client.user?.id ?? "";
  const botAlreadyReacted = await botHadReaction(message, emoji.key, botUserId);
  const updatedPanelHolder: { panel?: ReactionRolePanel } = {};
  await updateReactionRoleConfig(guild.id, (current) => {
    const stored = current.reactionRolePanels.find(
      (entry) => entry.messageId === panel.messageId,
    );
    if (!stored) {
      throw new ReactionRoleCommandError(
        "Panel Not Found",
        "That panel was removed before the mapping could be saved.",
      );
    }
    if (stored.mappings.some((entry) => entry.emojiKey === emoji.key)) {
      throw new ReactionRoleCommandError(
        "Duplicate Mapping",
        "That emoji already has a mapping on this panel.",
      );
    }
    updatedPanelHolder.panel = {
      ...stored,
      mappings: [...stored.mappings, mapping],
    };
    assertPanelEmbedFits(updatedPanelHolder.panel);
    return {
      reactionRolePanels: current.reactionRolePanels.map((entry) =>
        entry.messageId === stored.messageId ? updatedPanelHolder.panel! : entry,
      ),
    };
  });

  try {
    await message.react(emoji.reactValue);
    if (updatedPanelHolder.panel?.createdByBot) {
      await message.edit({ embeds: [buildPanelEmbed(updatedPanelHolder.panel)] });
    }
  } catch (error) {
    let rollbackFailed = false;
    try {
      await removeMappingFromConfig(guild.id, panel.messageId, emoji.key);
    } catch (rollbackError) {
      rollbackFailed = true;
      logger.error(
        `[REACTION ROLE] Could not roll back mapping ${message.id}/${emoji.key}:`,
        rollbackError instanceof Error ? rollbackError.message : rollbackError,
      );
    }
    if (botAlreadyReacted === false) {
      await removeBotReaction(message, emoji.key, botUserId);
    }
    if (updatedPanelHolder.panel?.createdByBot) {
      await message.edit({ embeds: [buildPanelEmbed(panel)] }).catch(() => null);
    }
    throw new ReactionRoleCommandError(
      "Mapping Could Not Be Added",
      `${describeReactionFailure(error)}${rollbackFailed ? " The saved configuration could not be rolled back; remove the mapping manually." : ""}`,
    );
  }

  await editNotice(
    interaction,
    "Reaction Role Added",
    `${GOLDEN_ARROW} ${emoji.display} → <@&${roleResult.role.id}>\n${GOLDEN_ARROW} Panel message: \`${panel.messageId}\``,
    "success",
  );
}

export async function assignExistingMessage(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): Promise<void> {
  const selectedChannel = interaction.options.getChannel("channel", true);
  const channel = await resolveReactionRoleChannel(guild, selectedChannel.id);
  if (!channel) {
    throw new ReactionRoleCommandError(
      "Invalid Channel",
      "Choose an available text or announcement channel in this server.",
    );
  }

  const messageId = requireMessageId(interaction);
  const permissionError = await checkBotChannelPermissions(
    guild,
    channel,
    [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AddReactions,
    ],
    "attach Reaction Roles to an existing message",
  );
  if (permissionError) {
    throw new ReactionRoleCommandError("Channel Permissions Required", permissionError);
  }

  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message || message.guildId !== guild.id) {
    throw new ReactionRoleCommandError(
      "Message Not Found",
      "The bot could not find or access that message in the selected channel. Check the message ID and the bot's View Channel and Read Message History permissions.",
    );
  }

  const emoji = requireEmoji(interaction.options.getString("emoji", true));
  const selectedRole = interaction.options.getRole("role", true);
  const roleResult = await resolveManageableRole(guild, selectedRole.id);
  if (!roleResult.role) {
    throw new ReactionRoleCommandError(
      "Role Cannot Be Managed",
      roleResult.error ?? "Choose another role.",
    );
  }

  const mapping: ReactionRoleMapping = {
    emoji: emoji.display,
    emojiKey: emoji.key,
    roleId: roleResult.role.id,
  };
  const botUserId = interaction.client.user?.id ?? "";
  const botAlreadyReacted = await botHadReaction(message, emoji.key, botUserId);
  let createdNewPanel = false;
  await updateReactionRoleConfig(guild.id, (current) => {
    const panels = current.reactionRolePanels ?? [];
    const existing = panels.find((entry) => entry.messageId === message.id);
    if (existing) {
      if (existing.channelId !== channel.id) {
        throw new ReactionRoleCommandError(
          "Panel Conflict",
          "That message is already configured in a different channel record.",
        );
      }
      if (existing.mappings.some((entry) => entry.emojiKey === emoji.key)) {
        throw new ReactionRoleCommandError(
          "Duplicate Mapping",
          "That emoji already has a mapping on this panel.",
        );
      }
      const updated = { ...existing, mappings: [...existing.mappings, mapping] };
      return {
        reactionRolePanels: panels.map((entry) =>
          entry.messageId === message.id ? updated : entry,
        ),
      };
    }

    createdNewPanel = true;
    const newPanel: ReactionRolePanel = {
      channelId: channel.id,
      messageId: message.id,
      title: "Existing Discord Message",
      description: "",
      createdByBot: false,
      mappings: [mapping],
    };
    return { reactionRolePanels: [...panels, newPanel] };
  });

  try {
    await message.react(emoji.reactValue);
  } catch (error) {
    let rollbackFailed = false;
    try {
      await updateReactionRoleConfig(guild.id, (current) => ({
        reactionRolePanels: current.reactionRolePanels
          .map((panel) => {
            if (panel.messageId !== message.id) return panel;
            return {
              ...panel,
              mappings: panel.mappings.filter(
                (entry) =>
                  !(
                    entry.emojiKey === emoji.key &&
                    entry.roleId === roleResult.role!.id
                  ),
              ),
            };
          })
          .filter(
            (panel) =>
              !(
                createdNewPanel &&
                panel.messageId === message.id &&
                panel.mappings.length === 0
              ),
          ),
      }));
    } catch (rollbackError) {
      rollbackFailed = true;
      logger.error(
        `[REACTION ROLE] Could not roll back assignment ${message.id}/${emoji.key}:`,
        rollbackError instanceof Error ? rollbackError.message : rollbackError,
      );
    }
    if (botAlreadyReacted === false) {
      await removeBotReaction(message, emoji.key, botUserId);
    }
    throw new ReactionRoleCommandError(
      "Reaction Could Not Be Added",
      `${describeReactionFailure(error)}${rollbackFailed ? " The saved configuration could not be rolled back; use `/reactionrole remove` to clean it up." : ""}`,
    );
  }

  await editNotice(
    interaction,
    "Existing Message Assigned",
    `${GOLDEN_ARROW} Message: \`${message.id}\` in <#${channel.id}>\n${GOLDEN_ARROW} Mapping: ${emoji.display} → <@&${roleResult.role.id}>\n${GOLDEN_ARROW} The existing message content was left unchanged.`,
    "success",
  );
}

export async function removeMapping(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): Promise<void> {
  const messageId = requireMessageId(interaction);
  const panel = findPanel(guild.id, messageId);
  if (!panel) {
    throw new ReactionRoleCommandError(
      "Panel Not Found",
      "No configured panel has that message ID.",
    );
  }
  const emoji = requireEmoji(interaction.options.getString("emoji", true));
  const mapping = panel.mappings.find((entry) => entry.emojiKey === emoji.key);
  if (!mapping) {
    throw new ReactionRoleCommandError(
      "Mapping Not Found",
      "That emoji does not have a mapping on this panel.",
    );
  }

  const { channel, message } = await fetchPanelMessage(guild, panel);
  const updatedPanel = {
    ...panel,
    mappings: panel.mappings.filter((entry) => entry.emojiKey !== emoji.key),
  };

  if (message && updatedPanel.createdByBot) {
    try {
      await message.edit({ embeds: [buildPanelEmbed(updatedPanel)] });
    } catch {
      throw new ReactionRoleCommandError(
        "Panel Could Not Be Updated",
        "The bot could not update this panel message, so the mapping was left unchanged.",
      );
    }
  }

  try {
    await updateReactionRoleConfig(guild.id, (current) => ({
      reactionRolePanels: current.reactionRolePanels.map((entry) =>
        entry.messageId === messageId ? updatedPanel : entry,
      ),
    }));
  } catch {
    if (message && panel.createdByBot) {
      await message.edit({ embeds: [buildPanelEmbed(panel)] }).catch(() => null);
    }
    throw new ReactionRoleCommandError(
      "Configuration Could Not Be Saved",
      "The mapping could not be removed from server configuration.",
    );
  }

  const cleanupDone = message
    ? await removeBotReaction(message, emoji.key, interaction.client.user?.id ?? "")
    : false;
  const messageNote =
    channel && message
      ? cleanupDone
        ? ""
        : "\nThe mapping was removed, but the bot reaction could not be cleared."
      : "\nThe panel message is unavailable; reaction cleanup was skipped.";
  await editNotice(
    interaction,
    "Reaction Role Removed",
    `${GOLDEN_ARROW} Removed ${emoji.display} → <@&${mapping.roleId}> from panel \`${messageId}\`.${messageNote}`,
    "success",
  );
}

export async function editPanel(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): Promise<void> {
  const messageId = requireMessageId(interaction);
  const panel = findPanel(guild.id, messageId);
  if (!panel) {
    throw new ReactionRoleCommandError(
      "Panel Not Found",
      "No configured panel has that message ID.",
    );
  }
  if (!panel.createdByBot) {
    throw new ReactionRoleCommandError(
      "External Message Cannot Be Edited",
      "This panel is attached to an existing Discord message. Discord does not let the bot edit another author's message; its content was left unchanged.",
    );
  }

  const title = interaction.options.getString("title");
  const description = interaction.options.getString("description");
  if (title === null && description === null) {
    throw new ReactionRoleCommandError(
      "No Changes Provided",
      "Provide a new title, description, or both.",
    );
  }
  const updatedPanel: ReactionRolePanel = {
    ...panel,
    title: title?.trim() || panel.title,
    description: description === null ? panel.description : description.trim(),
  };
  assertPanelEmbedFits(updatedPanel);

  const { message } = await fetchPanelMessage(guild, panel);
  if (!message) {
    throw new ReactionRoleCommandError(
      "Panel Message Unavailable",
      "The panel message was deleted or is inaccessible. Configuration was not changed.",
    );
  }

  try {
    await message.edit({ embeds: [buildPanelEmbed(updatedPanel)] });
  } catch {
    throw new ReactionRoleCommandError(
      "Panel Could Not Be Edited",
      "The bot could not edit that panel message. Its saved configuration was left unchanged.",
    );
  }
  try {
    await updateReactionRoleConfig(guild.id, (current) => ({
      reactionRolePanels: current.reactionRolePanels.map((entry) =>
        entry.messageId === messageId ? updatedPanel : entry,
      ),
    }));
  } catch {
    await message.edit({ embeds: [buildPanelEmbed(panel)] }).catch(() => null);
    throw new ReactionRoleCommandError(
      "Configuration Could Not Be Saved",
      "The previous panel content was restored because its updated configuration could not be saved.",
    );
  }

  await editNotice(
    interaction,
    "Panel Updated",
    `${GOLDEN_ARROW} Updated the title and description for panel \`${messageId}\`.`,
    "success",
  );
}

export async function listPanels(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  await interaction.editReply(
    panelListView(getReactionRolePanels(guildId), guildId, interaction.user.id, 0),
  );
}

export async function deletePanel(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
): Promise<void> {
  const messageId = requireMessageId(interaction);
  const panel = findPanel(guild.id, messageId);
  if (!panel) {
    throw new ReactionRoleCommandError(
      "Panel Not Found",
      "No configured panel has that message ID.",
    );
  }

  await updateReactionRoleConfig(guild.id, (current) => ({
    reactionRolePanels: current.reactionRolePanels.filter(
      (entry) => entry.messageId !== messageId,
    ),
  }));

  const { message } = await fetchPanelMessage(guild, panel);
  let cleaned = 0;
  if (message) {
    for (const mapping of panel.mappings) {
      if (
        await removeBotReaction(
          message,
          mapping.emojiKey,
          interaction.client.user?.id ?? "",
        )
      ) {
        cleaned += 1;
      }
    }
  }
  await editNotice(
    interaction,
    "Panel Configuration Deleted",
    `${GOLDEN_ARROW} Removed the configuration for \`${messageId}\`.\n${GOLDEN_ARROW} The Discord message was not deleted.${message ? `\n${GOLDEN_ARROW} Cleaned ${cleaned} managed bot reaction(s) where possible.` : "\nThe message was unavailable; reaction cleanup was skipped."}`,
    "success",
  );
}

export async function showConfig(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<void> {
  const panels = getReactionRolePanels(guildId);
  const assignmentCount = getReactionRoleAssignmentCount(guildId);
  await interaction.editReply({
    embeds: [
      createGodsEmbed({
        title: "Reaction Role Configuration",
        description: [
          `${GOLDEN_ARROW} Panels: **${panels.length}**`,
          `${GOLDEN_ARROW} Active member selections: **${assignmentCount}**`,
          `${GOLDEN_ARROW} One-role limit: **one Reaction Role per member**`,
          `${GOLDEN_ARROW} Panel and assignment data: **saved in this server's existing guild configuration**`,
        ].join("\n"),
        emoji: REACTION_ROLE_EMOJI,
      }),
    ],
  });
}

export async function withPanelOperationLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = panelOperationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  panelOperationQueues.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (panelOperationQueues.get(key) === current) {
      panelOperationQueues.delete(key);
    }
  }
}