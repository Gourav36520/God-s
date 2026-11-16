import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type MessageReaction,
  type PermissionResolvable,
  type Role,
  type TextChannel,
  type User,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { securityManager } from "../lib/registry.js";
import type { GuildSecurityConfig } from "../security/types.js";
import type {
  ReactionRoleAssignment,
  ReactionRoleMapping,
  ReactionRolePanel,
} from "./types.js";

type ReactionRoleConfigPatch = Partial<
  Omit<GuildSecurityConfig, "guildId" | "updatedAt">
>;
type ReactionRoleConfigUpdater = (
  current: GuildSecurityConfig,
) => ReactionRoleConfigPatch;

const configQueues = new Map<string, Promise<GuildSecurityConfig>>();
const memberQueues = new Map<string, Promise<void>>();

export const REACTION_ROLE_EMOJI = "<:Reaction_role:1554865929391841330>";

export interface NormalizedReactionEmoji {
  display: string;
  key: string;
  reactValue: string;
}

export function normalizeReactionEmoji(
  input: string,
): NormalizedReactionEmoji | null {
  const value = input.trim();
  const custom = /^<a?:[A-Za-z0-9_]{2,32}:(\d{17,20})>$/.exec(value);
  if (custom) {
    return { display: value, key: custom[1], reactValue: value };
  }

  if (
    value.length === 0 ||
    [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
      .length !== 1
  ) {
    return null;
  }

  const hasEmoji =
    /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}]/u.test(
      value,
    ) || /^[0-9#*]\uFE0F?\u20E3$/u.test(value);
  return hasEmoji ? { display: value, key: value, reactValue: value } : null;
}

export function getReactionEmojiKey(reaction: MessageReaction): string {
  return reaction.emoji.id ?? reaction.emoji.name ?? "";
}

export function getReactionRolePanels(guildId: string): ReactionRolePanel[] {
  const panels = securityManager.getConfig(guildId).reactionRolePanels;
  return Array.isArray(panels) ? panels : [];
}

export function getReactionRoleAssignment(
  guildId: string,
  userId: string,
): ReactionRoleAssignment | undefined {
  return securityManager.getConfig(guildId).reactionRoleAssignments?.[userId];
}

export function getReactionRoleAssignmentCount(guildId: string): number {
  return Object.keys(
    securityManager.getConfig(guildId).reactionRoleAssignments ?? {},
  ).length;
}

export async function updateReactionRoleConfig(
  guildId: string,
  update: ReactionRoleConfigUpdater,
): Promise<GuildSecurityConfig> {
  const previous = configQueues.get(guildId) ?? Promise.resolve(undefined);
  const current = previous
    .catch(() => undefined)
    .then(() => {
      const config = securityManager.getConfig(guildId);
      return securityManager.updateConfig(guildId, update(config));
    });

  configQueues.set(guildId, current);
  try {
    return await current;
  } finally {
    if (configQueues.get(guildId) === current) {
      configQueues.delete(guildId);
    }
  }
}

export async function updateReactionRoleAssignment(
  guildId: string,
  userId: string,
  assignment: ReactionRoleAssignment | null,
): Promise<void> {
  await updateReactionRoleConfig(guildId, (current) => {
    const assignments = { ...(current.reactionRoleAssignments ?? {}) };
    if (assignment) {
      assignments[userId] = assignment;
    } else {
      delete assignments[userId];
    }
    return { reactionRoleAssignments: assignments };
  });
}

export async function resolveReactionRoleChannel(
  guild: Guild,
  channelId: string,
): Promise<TextChannel | null> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement) ||
    !channel.isTextBased() ||
    !("messages" in channel) ||
    !("send" in channel)
  ) {
    return null;
  }
  return channel as TextChannel;
}

export async function checkBotChannelPermissions(
  guild: Guild,
  channel: TextChannel,
  required: readonly PermissionResolvable[],
  purpose: string,
): Promise<string | null> {
  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    return "The bot could not verify its server permissions. Try again shortly.";
  }

  const permissions = channel.permissionsFor(botMember);
  if (!permissions) {
    return "The bot cannot access the selected channel.";
  }

  const missing = required.filter((permission) => !permissions.has(permission));
  if (missing.length === 0) return null;

  const labels = missing.map((permission) => {
    if (permission === PermissionFlagsBits.ViewChannel) return "View Channel";
    if (permission === PermissionFlagsBits.ReadMessageHistory) {
      return "Read Message History";
    }
    if (permission === PermissionFlagsBits.SendMessages) return "Send Messages";
    if (permission === PermissionFlagsBits.EmbedLinks) return "Embed Links";
    if (permission === PermissionFlagsBits.AddReactions) return "Add Reactions";
    return "the required channel permissions";
  });
  return `The bot needs ${[...new Set(labels)].join(", ")} in <#${channel.id}> to ${purpose}.`;
}

export async function resolveManageableRole(
  guild: Guild,
  roleId: string,
): Promise<{ role: Role | null; error: string | null }> {
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    return { role: null, error: "That role no longer exists or is unavailable." };
  }
  if (role.id === guild.id) {
    return { role: null, error: "@everyone cannot be used as a Reaction Role." };
  }
  if (role.managed) {
    return {
      role: null,
      error: "That integration-managed role cannot be assigned by the bot.",
    };
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return {
      role: null,
      error: "The bot needs Manage Roles permission to manage that role.",
    };
  }
  if (role.position >= botMember.roles.highest.position) {
    return {
      role: null,
      error: "That role must be below the bot's highest role in Server Settings.",
    };
  }
  return { role, error: null };
}

export async function removeUserReaction(
  guild: Guild,
  channelId: string,
  messageId: string,
  emojiKey: string,
  userId: string,
): Promise<boolean> {
  try {
    const channel = await resolveReactionRoleChannel(guild, channelId);
    if (!channel) return false;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return false;
    const reaction = message.reactions.cache.find(
      (entry) => getReactionEmojiKey(entry) === emojiKey,
    );
    if (!reaction) return false;
    await reaction.users.remove(userId);
    return true;
  } catch {
    return false;
  }
}

export async function removeBotReaction(
  message: Message,
  emojiKey: string,
  botUserId: string,
): Promise<boolean> {
  try {
    const reaction = message.reactions.cache.find(
      (entry) => getReactionEmojiKey(entry) === emojiKey,
    );
    if (!reaction) return true;
    await reaction.users.remove(botUserId);
    return true;
  } catch {
    return false;
  }
}

export async function botHadReaction(
  message: Message,
  emojiKey: string,
  botUserId: string,
): Promise<boolean | null> {
  const reaction = message.reactions.cache.find(
    (entry) => getReactionEmojiKey(entry) === emojiKey,
  );
  if (!reaction) return false;
  const users = await reaction.users.fetch().catch(() => null);
  return users ? users.has(botUserId) : null;
}

async function withMemberQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = memberQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  memberQueues.set(key, current);
  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (memberQueues.get(key) === current) {
      memberQueues.delete(key);
    }
  }
}

async function hydrateReaction(
  reaction: MessageReaction,
): Promise<MessageReaction | null> {
  try {
    let resolved = reaction;
    if (resolved.partial) resolved = await resolved.fetch();
    if (resolved.message.partial) await resolved.message.fetch();
    return resolved;
  } catch {
    return null;
  }
}

async function removeFailedSelection(
  reaction: MessageReaction,
  userId: string,
): Promise<void> {
  await reaction.users.remove(userId).catch(() => null);
}

async function restoreRole(
  guild: Guild,
  member: GuildMember,
  roleId: string,
): Promise<void> {
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role || member.roles.cache.has(roleId)) return;
  await member.roles.add(role, "Restore prior Reaction Role after a failed update").catch(
    (error: unknown) => {
      logger.warn(
        `[REACTION ROLE] Could not restore role ${roleId} for ${member.id} in ${guild.id}:`,
        error instanceof Error ? error.message : error,
      );
    },
  );
}

function isSameAssignment(
  assignment: ReactionRoleAssignment,
  panel: ReactionRolePanel,
  mapping: ReactionRoleMapping,
): boolean {
  return (
    assignment.channelId === panel.channelId &&
    assignment.messageId === panel.messageId &&
    assignment.emojiKey === mapping.emojiKey &&
    assignment.roleId === mapping.roleId
  );
}

export async function handleReactionRoleAdd(
  reaction: MessageReaction,
  user: User,
): Promise<void> {
  try {
    if (user.bot) return;
    const resolvedReaction = await hydrateReaction(reaction);
    const message = resolvedReaction?.message;
    const guild = message?.guild;
    if (!resolvedReaction || !message || !guild) return;

    const guildId = guild.id;
    const channelId = message.channelId;
    const messageId = message.id;
    const emojiKey = getReactionEmojiKey(resolvedReaction);
    const initialPanel = getReactionRolePanels(guildId).find(
      (panel) => panel.messageId === messageId && panel.channelId === channelId,
    );
    if (!initialPanel) return;
    const initialMapping = initialPanel.mappings.find(
      (mapping) => mapping.emojiKey === emojiKey,
    );
    if (!initialMapping) return;

    await withMemberQueue(`${guildId}:${user.id}`, async () => {
      const panel = getReactionRolePanels(guildId).find(
        (entry) => entry.messageId === messageId && entry.channelId === channelId,
      );
      const mapping = panel?.mappings.find((entry) => entry.emojiKey === emojiKey);
      if (!panel || !mapping) return;

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      const target = await resolveManageableRole(guild, mapping.roleId);
      if (!target.role) {
        logger.warn(
          `[REACTION ROLE] Cannot assign role ${mapping.roleId} in ${guildId}: ${target.error}`,
        );
        await removeFailedSelection(resolvedReaction, user.id);
        return;
      }

      const previous = getReactionRoleAssignment(guildId, user.id);
      let removedPreviousRole = false;
      if (
        previous?.roleGrantedBySystem &&
        previous.roleId !== target.role.id &&
        member.roles.cache.has(previous.roleId)
      ) {
        const previousRole = await guild.roles.fetch(previous.roleId).catch(() => null);
        if (!previousRole) {
          logger.warn(
            `[REACTION ROLE] Prior role ${previous.roleId} is unavailable for ${user.id} in ${guildId}; selection skipped.`,
          );
          await removeFailedSelection(resolvedReaction, user.id);
          return;
        }
        const previousValidation = await resolveManageableRole(guild, previousRole.id);
        if (!previousValidation.role) {
          logger.warn(
            `[REACTION ROLE] Cannot replace prior role ${previous.roleId} in ${guildId}: ${previousValidation.error}`,
          );
          await removeFailedSelection(resolvedReaction, user.id);
          return;
        }
        try {
          await member.roles.remove(
            previousRole,
            "Replace prior Reaction Role selection",
          );
          removedPreviousRole = true;
        } catch (error) {
          logger.warn(
            `[REACTION ROLE] Could not remove prior role ${previousRole.id} from ${user.id} in ${guildId}:`,
            error instanceof Error ? error.message : error,
          );
          await removeFailedSelection(resolvedReaction, user.id);
          return;
        }
      }

      const targetWasPresent = member.roles.cache.has(target.role.id);
      let addedTargetRole = false;
      if (!targetWasPresent) {
        try {
          await member.roles.add(target.role, "Reaction Role selection");
          addedTargetRole = true;
        } catch (error) {
          logger.warn(
            `[REACTION ROLE] Could not assign role ${target.role.id} to ${user.id} in ${guildId}:`,
            error instanceof Error ? error.message : error,
          );
          if (removedPreviousRole && previous) {
            await restoreRole(guild, member, previous.roleId);
          }
          await removeFailedSelection(resolvedReaction, user.id);
          return;
        }
      }

      const assignment: ReactionRoleAssignment = {
        channelId,
        messageId,
        emojiKey,
        roleId: target.role.id,
        roleGrantedBySystem:
          previous?.roleId === target.role.id
            ? previous.roleGrantedBySystem
            : !targetWasPresent,
      };
      try {
        await updateReactionRoleAssignment(guildId, user.id, assignment);
      } catch (error) {
        logger.warn(
          `[REACTION ROLE] Could not save selection state for ${user.id} in ${guildId}:`,
          error instanceof Error ? error.message : error,
        );
        if (addedTargetRole) {
          await member.roles.remove(
            target.role,
            "Roll back unsaved Reaction Role selection",
          ).catch(() => null);
        }
        if (removedPreviousRole && previous) {
          await restoreRole(guild, member, previous.roleId);
        }
        await removeFailedSelection(resolvedReaction, user.id);
        return;
      }

      if (
        previous &&
        (previous.channelId !== channelId ||
          previous.messageId !== messageId ||
          previous.emojiKey !== emojiKey)
      ) {
        const previousReactionRemoved = await removeUserReaction(
          guild,
          previous.channelId,
          previous.messageId,
          previous.emojiKey,
          user.id,
        );
        if (!previousReactionRemoved) {
          logger.warn(
            `[REACTION ROLE] Updated role selection for ${user.id} in ${guildId}, but could not remove their prior reaction.`,
          );
        }
      }
    });
  } catch (error) {
    logger.warn(
      `[REACTION ROLE] Reaction-add handler failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function handleReactionRoleRemove(
  reaction: MessageReaction,
  user: User,
): Promise<void> {
  try {
    if (user.bot) return;
    const resolvedReaction = await hydrateReaction(reaction);
    const message = resolvedReaction?.message;
    const guild = message?.guild;
    if (!resolvedReaction || !message || !guild) return;

    const guildId = guild.id;
    const channelId = message.channelId;
    const messageId = message.id;
    const emojiKey = getReactionEmojiKey(resolvedReaction);

    await withMemberQueue(`${guildId}:${user.id}`, async () => {
      const assignment = getReactionRoleAssignment(guildId, user.id);
      if (
        !assignment ||
        assignment.channelId !== channelId ||
        assignment.messageId !== messageId ||
        assignment.emojiKey !== emojiKey
      ) {
        return;
      }

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return;

      let removedRole: Role | null = null;
      if (
        assignment.roleGrantedBySystem &&
        member.roles.cache.has(assignment.roleId)
      ) {
        const validation = await resolveManageableRole(guild, assignment.roleId);
        if (!validation.role) {
          if (validation.error !== "That role no longer exists or is unavailable.") {
            logger.warn(
              `[REACTION ROLE] Could not remove role ${assignment.roleId} from ${user.id} in ${guildId}: ${validation.error}`,
            );
            return;
          }
        } else {
          try {
            await member.roles.remove(
              validation.role,
              "Reaction Role reaction removed",
            );
            removedRole = validation.role;
          } catch (error) {
            logger.warn(
              `[REACTION ROLE] Could not remove role ${assignment.roleId} from ${user.id} in ${guildId}:`,
              error instanceof Error ? error.message : error,
            );
            return;
          }
        }
      }

      try {
        await updateReactionRoleAssignment(guildId, user.id, null);
      } catch (error) {
        logger.warn(
          `[REACTION ROLE] Could not clear selection state for ${user.id} in ${guildId}:`,
          error instanceof Error ? error.message : error,
        );
        if (removedRole) {
          await restoreRole(guild, member, removedRole.id);
        }
      }
    });
  } catch (error) {
    logger.warn(
      `[REACTION ROLE] Reaction-remove handler failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}