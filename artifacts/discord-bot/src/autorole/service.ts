import {
  PermissionFlagsBits,
  type GuildMember,
} from "discord.js";
import { securityManager } from "../lib/registry.js";
import { logger } from "../lib/logger.js";

const assignmentsInProgress = new Set<string>();

export async function assignAutoRole(member: GuildMember): Promise<void> {
  if (member.user.bot) return;

  const guildId = member.guild.id;
  const attemptKey = `${guildId}:${member.id}`;
  if (assignmentsInProgress.has(attemptKey)) return;

  assignmentsInProgress.add(attemptKey);
  let roleId: string | null = null;
  try {
    roleId = securityManager.getConfig(guildId).autoRoleRoleId;
    if (!roleId || member.roles.cache.has(roleId)) return;

    const role =
      member.guild.roles.cache.get(roleId) ??
      (await member.guild.roles.fetch(roleId).catch(() => null));
    if (!role || role.id === guildId) {
      logger.warn(
        `[AUTO ROLE] Configured role ${roleId} is unavailable in guild ${guildId}; skipped member ${member.id}.`,
      );
      return;
    }

    const botMember =
      member.guild.members.me ??
      (await member.guild.members.fetchMe().catch(() => null));
    if (
      !botMember ||
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
      role.position >= botMember.roles.highest.position
    ) {
      logger.warn(
        `[AUTO ROLE] Role ${roleId} is not manageable by the bot in guild ${guildId}; skipped member ${member.id}.`,
      );
      return;
    }

    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(role, "Configured Auto Role");
    }
  } catch (error) {
    logger.warn(
      `[AUTO ROLE] Could not assign the configured role to member ${member.id} in guild ${guildId}:`,
      error instanceof Error ? error.message : error,
    );
  } finally {
    assignmentsInProgress.delete(attemptKey);
  }
}