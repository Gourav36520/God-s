import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type PermissionResolvable,
} from "discord.js";
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
