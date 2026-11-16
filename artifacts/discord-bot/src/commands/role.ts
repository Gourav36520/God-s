import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import {
  deny,
  fetchTargetMember,
  requireConfiguredRoleMember,
  resolveModerationContext,
  roleAssignmentIssue,
} from "../moderation/permissions.js";

export const data = new SlashCommandBuilder()
  .setName("role")
  .setDescription("Assign or remove a role below the Manager role")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Give a member an eligible role")
      .addUserOption((option) =>
        option.setName("member").setDescription("The member").setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("The role to assign").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove an eligible role from a member")
      .addUserOption((option) =>
        option.setName("member").setDescription("The member").setRequired(true),
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("The role to remove").setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await resolveModerationContext(interaction);
  if (!context) return;
  const managerRole = await requireConfiguredRoleMember(
    interaction,
    context,
    "managerRoleId",
    "Manager",
  );
  if (!managerRole) return;
  if (!context.bot.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await deny(interaction, "The bot needs the Manage Roles permission to do that.");
    return;
  }

  const user = interaction.options.getUser("member", true);
  const selectedRole = interaction.options.getRole("role", true);
  const role = await context.guild.roles
    .fetch(selectedRole.id)
    .catch(() => null);
  if (!role) {
    await deny(interaction, "That role no longer exists in this server.");
    return;
  }
  const target = await fetchTargetMember(context, user.id);
  if (!target) {
    await deny(interaction, "That member is no longer in this server.");
    return;
  }

  const issue = roleAssignmentIssue(context, managerRole, role, target);
  if (issue) {
    await deny(interaction, issue);
    return;
  }

  const add = interaction.options.getSubcommand() === "add";
  const alreadyHasRole = target.roles.cache.has(role.id);
  if (add && alreadyHasRole) {
    await interaction.reply({
      content: `${target} already has ${role}.`,
      ephemeral: true,
    });
    return;
  }
  if (!add && !alreadyHasRole) {
    await interaction.reply({
      content: `${target} does not have ${role}.`,
      ephemeral: true,
    });
    return;
  }

  const reason = `Role ${add ? "added" : "removed"} by ${interaction.user.tag} (${interaction.user.id}) via /role ${add ? "add" : "remove"}`;
  if (add) {
    await target.roles.add(role, reason);
  } else {
    await target.roles.remove(role, reason);
  }
  await interaction.reply({
    content: `${role} ${add ? "added to" : "removed from"} ${target}.`,
    ephemeral: true,
  });
}
