import { SlashCommandBuilder } from "discord.js";
import {
  getModerationRoleConfig,
  setModerationRoleConfig,
} from "@workspace/db";
import type { ModerationRoleField } from "@workspace/db";
import type { Command } from "../lib/registry.js";
import { logger } from "../lib/logger.js";
import { replyPrivate } from "../moderation/permissions.js";

export interface ModerationRoleConfigCommandDependencies {
  getModerationRoleConfig: typeof getModerationRoleConfig;
  setModerationRoleConfig: typeof setModerationRoleConfig;
}

const ROLE_CONFIGURATIONS: {
  name: string;
  description: string;
  label: string;
  field: ModerationRoleField;
}[] = [
  {
    name: "admin-role",
    description: "Configure the role for admin-level bot commands",
    label: "Admin",
    field: "adminRoleId",
  },
  {
    name: "manager",
    description: "Configure the role for manager bot commands",
    label: "Manager",
    field: "managerRoleId",
  },
  {
    name: "warn-role",
    description: "Configure the role allowed to issue warnings",
    label: "Warn",
    field: "warnRoleId",
  },
  {
    name: "timeout-role",
    description: "Configure the role allowed to use timeout commands",
    label: "Timeout",
    field: "timeoutRoleId",
  },
  {
    name: "req-staff",
    description: "Configure the role allowed to use /staff",
    label: "Staff Request",
    field: "staffRequestRoleId",
  },
];

export function createModerationRoleConfigCommands(
  dependencies: ModerationRoleConfigCommandDependencies = {
    getModerationRoleConfig,
    setModerationRoleConfig,
  },
): Command[] {
  return ROLE_CONFIGURATIONS.map((configuration) => {
    const data = new SlashCommandBuilder()
      .setName(configuration.name)
      .setDescription(configuration.description)
      .setDefaultMemberPermissions(null)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription(`Set the ${configuration.label} role`)
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription(`The ${configuration.label} role`)
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription(`Clear the configured ${configuration.label} role`),
      );

    return {
      data,
      execute: async (interaction) => {
        const guild = interaction.guild;
        if (!guild) {
          await replyPrivate(
            interaction,
            "Server Only",
            "Role configuration can only be changed inside a server.",
          );
          return;
        }
        if (interaction.user.id !== guild.ownerId) {
          await replyPrivate(
            interaction,
            "Server Owner Only",
            "Only this server's actual owner can configure moderation roles.",
          );
          return;
        }

        const action = interaction.options.getSubcommand();
        let current;
        try {
          current = await dependencies.getModerationRoleConfig(guild.id);
        } catch {
          await replyPrivate(
            interaction,
            "Role Settings Unavailable",
            "The role settings could not be loaded. No changes were made.",
          );
          return;
        }

        if (action === "remove") {
          if (!current?.[configuration.field]) {
            await replyPrivate(
              interaction,
              "Role Not Configured",
              `No ${configuration.label} role is currently configured.`,
              "info",
            );
            return;
          }
          try {
            await dependencies.setModerationRoleConfig(
              guild.id,
              configuration.field,
              null,
            );
            await replyPrivate(
              interaction,
              "Role Configuration Removed",
              `The ${configuration.label} role is no longer configured.`,
              "success",
            );
          } catch (error) {
            logger.warn(
              `Could not remove ${configuration.label} role config in guild=${guild.id}:`,
              error instanceof Error ? error.name : "unknown error",
            );
            await replyPrivate(
              interaction,
              "Role Settings Not Saved",
              "The role setting could not be saved. No success was reported.",
            );
          }
          return;
        }

        const selectedRole = interaction.options.getRole("role", true);
        const role = await guild.roles.fetch(selectedRole.id).catch(() => null);
        if (!role || role.id === guild.id || role.managed) {
          await replyPrivate(
            interaction,
            "Invalid Role",
            "Choose an available server role that is not @everyone or managed by an integration.",
          );
          return;
        }

        const duplicate = ROLE_CONFIGURATIONS.find(
          (other) =>
            other.field !== configuration.field &&
            current?.[other.field] === role.id,
        );
        if (duplicate) {
          await replyPrivate(
            interaction,
            "Role Already In Use",
            `That role is already configured for ${duplicate.label}. Choose a distinct role so permissions remain separate.`,
          );
          return;
        }

        try {
          await dependencies.setModerationRoleConfig(
            guild.id,
            configuration.field,
            role.id,
          );
          await replyPrivate(
            interaction,
            "Role Configuration Saved",
            `${configuration.label} role is now <@&${role.id}>.`,
            "success",
          );
        } catch (error) {
          logger.warn(
            `Could not save ${configuration.label} role config in guild=${guild.id}:`,
            error instanceof Error ? error.name : "unknown error",
          );
          await replyPrivate(
            interaction,
            "Role Settings Not Saved",
            "The role setting could not be saved. No success was reported.",
          );
        }
      },
    };
  });
}

export const moderationRoleConfigCommands =
  createModerationRoleConfigCommands();
