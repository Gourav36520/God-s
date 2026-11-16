import { PermissionFlagsBits } from "discord.js";
import type {
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  Role,
} from "discord.js";
import { securityManager } from "../lib/registry.js";
import type { GuildSecurityConfig } from "../security/types.js";

export type ConfiguredModerationRole =
  | "adminRoleId"
  | "managerRoleId"
  | "warnRoleId"
  | "timeoutRoleId"
  | "staffRequestRoleId";

export interface ModerationContext {
  guild: Guild;
  actor: GuildMember;
  bot: GuildMember;
}

export async function deny(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({ content, ephemeral: true });
}

export async function resolveModerationContext(
  interaction: ChatInputCommandInteraction,
): Promise<ModerationContext | null> {
  if (!interaction.inGuild() || !interaction.guild) {
    await deny(interaction, "This command can only be used in a server.");
    return null;
  }

  const guild = interaction.guild;
  try {
    await guild.roles.fetch();
    const [actor, bot] = await Promise.all([
      guild.members.fetch({ user: interaction.user.id, force: true }),
      guild.members.fetchMe(),
    ]);
    return { guild, actor, bot };
  } catch {
    await deny(
      interaction,
      "I couldn't verify the current server roles and permissions, so no action was taken.",
    );
    return null;
  }
}

export async function fetchTargetMember(
  context: ModerationContext,
  userId: string,
): Promise<GuildMember | null> {
  return context.guild.members
    .fetch({ user: userId, force: true })
    .catch(() => null);
}

export function isServerOwner(context: ModerationContext): boolean {
  return context.guild.ownerId === context.actor.id;
}

export async function requireServerOwner(
  interaction: ChatInputCommandInteraction,
  context: ModerationContext,
): Promise<boolean> {
  if (isServerOwner(context)) return true;
  await deny(interaction, "Only the actual server owner can use this command.");
  return false;
}

export async function fetchConfiguredRole(
  interaction: ChatInputCommandInteraction,
  context: ModerationContext,
  key: ConfiguredModerationRole,
  label: string,
): Promise<Role | null> {
  const roleId = securityManager.getConfig(context.guild.id)[key];
  if (typeof roleId !== "string" || roleId.length === 0) {
    await deny(interaction, `No ${label} role is configured for this server.`);
    return null;
  }

  const role = await context.guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    await deny(
      interaction,
      `The configured ${label} role no longer exists. The server owner must remove or reconfigure it.`,
    );
    return null;
  }
  return role;
}

export async function requireConfiguredRoleMember(
  interaction: ChatInputCommandInteraction,
  context: ModerationContext,
  key: ConfiguredModerationRole,
  label: string,
): Promise<Role | null> {
  const role = await fetchConfiguredRole(interaction, context, key, label);
  if (!role) return null;
  if (!context.actor.roles.cache.has(role.id)) {
    await deny(interaction, `Only members with the configured ${label} role can use this command.`);
    return null;
  }
  return role;
}

export async function requireAdminManagerOrOwner(
  interaction: ChatInputCommandInteraction,
  context: ModerationContext,
): Promise<boolean> {
  if (isServerOwner(context)) return true;

  const config = securityManager.getConfig(context.guild.id);
  const configuredRoles: Array<[ConfiguredModerationRole, string]> = [
    ["adminRoleId", "Admin"],
    ["managerRoleId", "Manager"],
  ];

  for (const [key] of configuredRoles) {
    const roleId = config[key];
    if (typeof roleId !== "string" || roleId.length === 0) continue;
    const role = await context.guild.roles.fetch(roleId).catch(() => null);
    if (role && context.actor.roles.cache.has(role.id)) return true;
  }

  await deny(
    interaction,
    "Only the actual server owner or a member of the configured Admin or Manager role can use this command.",
  );
  return false;
}

export function memberHierarchyIssue(
  context: ModerationContext,
  target: GuildMember,
): string | null {
  if (target.id === context.guild.ownerId) {
    return "The server owner cannot be targeted by this command.";
  }
  if (target.id === context.bot.id) {
    return "The bot cannot target itself.";
  }
  if (target.roles.highest.comparePositionTo(context.bot.roles.highest) >= 0) {
    return "The target's highest role must be below the bot's highest role.";
  }
  if (
    !isServerOwner(context) &&
    target.roles.highest.comparePositionTo(context.actor.roles.highest) >= 0
  ) {
    return "Your highest role must be above the target's highest role.";
  }
  return null;
}

export function roleConfigurationIssue(
  context: ModerationContext,
  role: Role,
  key: ConfiguredModerationRole,
): string | null {
  if (role.guild.id !== context.guild.id || role.id === context.guild.id) {
    return "Choose a role from this server other than @everyone.";
  }
  if (role.managed) {
    return "Managed integration and bot roles cannot be configured here.";
  }
  if (
    key === "managerRoleId" &&
    role.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return "The Manager role cannot grant Discord Administrator permission.";
  }
  return null;
}

export function roleAssignmentIssue(
  context: ModerationContext,
  managerRole: Role,
  role: Role,
  target: GuildMember,
): string | null {
  if (role.id === context.guild.id) {
    return "@everyone cannot be assigned or removed with this command.";
  }
  if (role.managed || context.bot.roles.cache.has(role.id)) {
    return "Managed integration and protected bot roles cannot be changed.";
  }
  if (role.permissions.has(PermissionFlagsBits.Administrator)) {
    return "Roles with Discord Administrator permission cannot be changed with this command.";
  }
  if (role.comparePositionTo(managerRole) >= 0) {
    return "Managers can only manage roles below the configured Manager role.";
  }
  if (role.comparePositionTo(context.actor.roles.highest) >= 0) {
    return "The role must also be below your highest role.";
  }
  if (role.comparePositionTo(context.bot.roles.highest) >= 0) {
    return "The bot cannot manage a role at or above its highest role.";
  }
  if (target.roles.cache.some((memberRole) =>
    memberRole.permissions.has(PermissionFlagsBits.Administrator),
  )) {
    return "Members with Discord Administrator permission cannot be changed with this command.";
  }
  const targetIssue = memberHierarchyIssue(context, target);
  if (targetIssue) return targetIssue;
  if (target.roles.highest.comparePositionTo(managerRole) >= 0) {
    return "Managers can only change members whose highest role is below the configured Manager role.";
  }
  return null;
}

export type ModerationRoleConfig = Pick<
  GuildSecurityConfig,
  ConfiguredModerationRole
>;
