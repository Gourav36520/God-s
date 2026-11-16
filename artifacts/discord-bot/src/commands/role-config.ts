import { SlashCommandBuilder } from "discord.js";
import type {
  ChatInputCommandInteraction,
  SharedSlashCommand,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { securityManager } from "../lib/registry.js";
import type { ConfiguredModerationRole } from "../moderation/permissions.js";
import {
  deny,
  requireServerOwner,
  resolveModerationContext,
  roleConfigurationIssue,
} from "../moderation/permissions.js";

interface RoleConfigCommand {
  data: SharedSlashCommand;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

function createRoleConfigCommand(
  commandName: string,
  label: string,
  key: ConfiguredModerationRole,
): RoleConfigCommand {
  const data = new SlashCommandBuilder()
    .setName(commandName)
    .setDescription(`Configure the single ${label} role`)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription(`Set the ${label} role`)
        .addRoleOption((option) =>
          option.setName("role").setDescription(`The ${label} role`).setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("remove").setDescription(`Remove the configured ${label} role`),
    );

  return {
    data,
    async execute(interaction): Promise<void> {
      const context = await resolveModerationContext(interaction);
      if (!context || !(await requireServerOwner(interaction, context))) return;

      const subcommand = interaction.options.getSubcommand();
      const currentRoleId = securityManager.getConfig(context.guild.id)[key];

      if (subcommand === "remove") {
        if (!currentRoleId) {
          await deny(interaction, `No ${label} role is configured.`);
          return;
        }
        await securityManager.updateConfig(context.guild.id, { [key]: null });
        logger.info(
          `Moderation role removed: category=${label} guild=${context.guild.id} owner=${context.actor.id}`,
        );
        await interaction.reply({
          content: `The configured ${label} role has been removed.`,
          ephemeral: true,
        });
        return;
      }

      const selectedRole = interaction.options.getRole("role", true);
      const role = await context.guild.roles
        .fetch(selectedRole.id)
        .catch(() => null);
      if (!role) {
        await deny(interaction, "That role no longer exists in this server.");
        return;
      }
      const issue = roleConfigurationIssue(context, role, key);
      if (issue) {
        await deny(interaction, issue);
        return;
      }
      if (currentRoleId) {
        const message =
          currentRoleId === role.id
            ? `That role is already configured as the ${label} role.`
            : `A ${label} role is already configured. Remove it before setting another role.`;
        await deny(interaction, message);
        return;
      }

      await securityManager.updateConfig(context.guild.id, { [key]: role.id });
      logger.info(
        `Moderation role configured: category=${label} role=${role.id} guild=${context.guild.id} owner=${context.actor.id}`,
      );
      await interaction.reply({
        content: `Configured ${role} as the single ${label} role.`,
        ephemeral: true,
      });
    },
  };
}

export const adminRole = createRoleConfigCommand("admin-role", "Admin", "adminRoleId");
export const managerRole = createRoleConfigCommand("manager", "Manager", "managerRoleId");
export const warnRole = createRoleConfigCommand("warn-role", "Warn", "warnRoleId");
export const timeoutRole = createRoleConfigCommand("timeout-role", "Timeout", "timeoutRoleId");
export const staffRequestRole = createRoleConfigCommand(
  "req-staff",
  "Staff Request",
  "staffRequestRoleId",
);
