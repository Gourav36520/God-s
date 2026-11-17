import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type PermissionResolvable,
} from "discord.js";
import { getModerationRoleConfig } from "@workspace/db";
import type { ModerationRoleField } from "@workspace/db";
import { createGodsEmbed } from "../commands/ui.js";

export interface ModerationContext {
  guild: Guild;
  moderator: GuildMember;
  botMember: GuildMember;
}

export async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  title: string,
  message: string,
  tone: "success" | "error" | "warning" | "info" = "error",
): Promise<void> {
  const embed = createGodsEmbed({
    title,
    description: message,
    tone,
  });

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], components: [] });
  } else {
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

export async function requireModerationContext(
  interaction: ChatInputCommandInteraction,
  permission: PermissionResolvable,
): Promise<ModerationContext | null> {
  const guild = interaction.guild;
  if (!guild) {
    await replyPrivate(
      interaction,
      "Server Only",
      "This moderation command can only be used inside a server.",
    );
    return null;
  }

  const [moderator, botMember] = await Promise.all([
    guild.members.fetch(interaction.user.id).catch(() => null),
    guild.members.me
      ? Promise.resolve(guild.members.me)
      : guild.members.fetchMe().catch(() => null),
  ]);

  if (!moderator || !botMember) {
    await replyPrivate(
      interaction,
      "Member Unavailable",
      "The moderator or bot could not be verified in this server.",
    );
    return null;
  }

  if (!moderator.permissions.has(permission)) {
    await replyPrivate(
      interaction,
      "Permission Required",
      "You do not have the server permission required for this action.",
    );
    return null;
  }

  if (!botMember.permissions.has(permission)) {
    await replyPrivate(
      interaction,
      "Bot Permission Missing",
      "Gods Bot is missing the server permission required for this action.",
    );
    return null;
  }

  return { guild, moderator, botMember };
}

type ModerationRoleAccess =
  | { ownerOnly: true }
  | {
      roleFields: ModerationRoleField[];
      ownerBypass?: boolean;
    };

export async function getConfiguredModerationRoleAccess(
  guild: Guild,
  moderator: GuildMember,
  fields: ModerationRoleField[],
): Promise<{ configured: boolean; hasRole: boolean }> {
  const config = await getModerationRoleConfig(guild.id);
  const roleIds = fields
    .map((field) => config?.[field] ?? null)
    .filter((roleId): roleId is string => Boolean(roleId));
  if (roleIds.length === 0) {
    return { configured: false, hasRole: false };
  }

  const roles = await Promise.all(
    roleIds.map((roleId) => guild.roles.fetch(roleId).catch(() => null)),
  );
  return {
    configured: true,
    hasRole: roles.some((role) => role && moderator.roles.cache.has(role.id)),
  };
}

export async function requireConfiguredModerationContext(
  interaction: ChatInputCommandInteraction,
  permission: PermissionResolvable | null,
  access: ModerationRoleAccess,
): Promise<ModerationContext | null> {
  const guild = interaction.guild;
  if (!guild) {
    await replyPrivate(
      interaction,
      "Server Only",
      "This moderation command can only be used inside a server.",
    );
    return null;
  }

  const [moderator, botMember] = await Promise.all([
    guild.members.fetch(interaction.user.id).catch(() => null),
    guild.members.me
      ? Promise.resolve(guild.members.me)
      : guild.members.fetchMe().catch(() => null),
  ]);

  if (!moderator || !botMember) {
    await replyPrivate(
      interaction,
      "Member Unavailable",
      "The moderator or bot could not be verified in this server.",
    );
    return null;
  }

  const isOwner = moderator.id === guild.ownerId;
  if ("ownerOnly" in access && !isOwner) {
    await replyPrivate(
      interaction,
      "Server Owner Only",
      "Only this server's actual owner can use this command.",
    );
    return null;
  }

  if (
    "roleFields" in access &&
    !(access.ownerBypass && isOwner)
  ) {
    let roleAccess: { configured: boolean; hasRole: boolean };
    try {
      roleAccess = await getConfiguredModerationRoleAccess(
        guild,
        moderator,
        access.roleFields,
      );
    } catch {
      await replyPrivate(
        interaction,
        "Role Settings Unavailable",
        "The configured role permissions could not be verified, so this command was denied.",
      );
      return null;
    }

    if (!roleAccess.configured) {
      await replyPrivate(
        interaction,
        "Role Not Configured",
        "The server owner must configure a required role before this command can be used.",
      );
      return null;
    }

    if (!roleAccess.hasRole) {
      await replyPrivate(
        interaction,
        "Role Required",
        "You do not have a configured role required for this command.",
      );
      return null;
    }
  }

  if (permission !== null && !botMember.permissions.has(permission)) {
    await replyPrivate(
      interaction,
      "Bot Permission Missing",
      "Gods Bot is missing the server permission required for this action.",
    );
    return null;
  }

  return { guild, moderator, botMember };
}

export function targetHierarchyError(
  context: ModerationContext,
  target: GuildMember,
): string | null {
  if (target.id === context.guild.ownerId) {
    return "The server owner cannot be moderated by the bot.";
  }

  if (
    target.permissions.has(PermissionFlagsBits.Administrator) &&
    !context.moderator.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return "You cannot moderate a server administrator.";
  }

  if (
    context.moderator.id !== context.guild.ownerId &&
    context.moderator.roles.highest.comparePositionTo(target.roles.highest) <= 0
  ) {
    return "Your highest role must be above the target's highest role.";
  }

  if (
    context.botMember.roles.highest.comparePositionTo(target.roles.highest) <= 0
  ) {
    return "Gods Bot's highest role must be above the target's highest role.";
  }

  return null;
}

export function roleHierarchyError(
  context: ModerationContext,
  target: GuildMember,
  roleId: string,
): string | null {
  const role = context.guild.roles.cache.get(roleId);
  if (!role || role.id === context.guild.id) {
    return "Choose a valid, assignable server role.";
  }
  if (role.managed) {
    return "Managed integration roles cannot be assigned or removed manually.";
  }
  if (
    context.botMember.roles.highest.comparePositionTo(role) <= 0
  ) {
    return "Gods Bot's highest role must be above the selected role.";
  }
  if (
    context.moderator.id !== context.guild.ownerId &&
    context.moderator.roles.highest.comparePositionTo(role) <= 0
  ) {
    return "Your highest role must be above the selected role.";
  }
  if (role.permissions.has(PermissionFlagsBits.Administrator)) {
    return "Administrator roles cannot be assigned with this command.";
  }
  const targetError = targetHierarchyError(context, target);
  if (targetError) return targetError;
  return null;
}
