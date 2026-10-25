import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type Role,
} from "discord.js";
import { securityManager } from "../lib/registry.js";
import { arrowLine, createGodsEmbed, GODS_EMOJI } from "./ui.js";

export const data = new SlashCommandBuilder()
  .setName("autorole")
  .setDescription("Configure the role assigned to new members")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("setup")
      .setDescription("Choose and enable the Auto Role")
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Role to assign to new members")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("role")
      .setDescription("Show or change the Auto Role")
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Optional replacement Auto Role"),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Disable the Auto Role"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("config")
      .setDescription("Show Auto Role status and configured role"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Server Required",
          description: "Run this command inside the server you want to configure.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Manage Server Permission Required",
          description: "Only members with Manage Server permission can configure Auto Role.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId;
  const guild = interaction.guild;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "setup") {
    const selectedRole = interaction.options.getRole("role", true);
    const role = await guild.roles.fetch(selectedRole.id).catch(() => null);
    if (!role) {
      await replyRoleUnavailable(interaction);
      return;
    }
    await saveRole(interaction, guildId, role);
    return;
  }

  if (subcommand === "role") {
    const selectedRole = interaction.options.getRole("role");
    if (selectedRole) {
      const role = await guild.roles.fetch(selectedRole.id).catch(() => null);
      if (!role) {
        await replyRoleUnavailable(interaction);
        return;
      }
      await saveRole(interaction, guildId, role);
      return;
    }
    await replyWithCurrentRole(interaction, guild, "Auto Role");
    return;
  }

  if (subcommand === "remove") {
    try {
      await securityManager.updateConfig(guildId, { autoRoleRoleId: null });
      await interaction.reply({
        embeds: [
          createGodsEmbed({
            title: "Auto Role Disabled",
            description: "New members will no longer receive an automatic role.",
            emoji: GODS_EMOJI.settings,
            tone: "success",
          }),
        ],
        ephemeral: true,
      });
    } catch {
      await replySaveError(interaction);
    }
    return;
  }

  await replyWithCurrentRole(interaction, guild, "Auto Role Configuration");
}

async function saveRole(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  role: Role,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;

  const reason = await validateRole(guild, role);
  if (reason) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Auto Role Not Saved",
          description: reason,
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  try {
    await securityManager.updateConfig(guildId, { autoRoleRoleId: role.id });
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Auto Role Updated",
          description: [
            "New human members will receive this role when they join.",
            "",
            arrowLine("Auto Role", `<@&${role.id}>`),
          ].join("\n"),
          emoji: GODS_EMOJI.settings,
          tone: "success",
        }),
      ],
      ephemeral: true,
    });
  } catch {
    await replySaveError(interaction);
  }
}

async function validateRole(guild: Guild, role: Role): Promise<string | null> {
  if (role.guild.id !== guild.id) {
    return "Choose a role from this server.";
  }
  if (role.id === guild.id) {
    return "The @everyone role cannot be used as the Auto Role.";
  }

  const botMember =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    return "I could not verify my server role permissions. Please try again.";
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "I need the Manage Roles permission before an Auto Role can be configured.";
  }
  if (role.position >= botMember.roles.highest.position) {
    return "Move my highest role above the selected role, then try again.";
  }
  return null;
}

async function replyWithCurrentRole(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  title: string,
): Promise<void> {
  const roleId = securityManager.getConfig(guild.id).autoRoleRoleId;
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  const enabled = Boolean(roleId);
  const roleValue = role
    ? `<@&${role.id}>`
    : roleId
      ? `Unavailable role (<@&${roleId}>)`
      : "Not configured";

  await interaction.reply({
    embeds: [
      createGodsEmbed({
        title,
        description: [
          arrowLine("Status", enabled ? "Enabled" : "Disabled"),
          arrowLine("Role", roleValue),
          ...(title === "Auto Role"
            ? ["", "To change it, choose a role with `/autorole role`."]
            : []),
        ].join("\n"),
        emoji: GODS_EMOJI.settings,
      }),
    ],
    ephemeral: true,
  });
}

async function replySaveError(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    embeds: [
      createGodsEmbed({
        title: "Auto Role Not Saved",
        description: "The setting could not be saved. Please try again.",
        emoji: GODS_EMOJI.settings,
        tone: "error",
      }),
    ],
    ephemeral: true,
  });
}

async function replyRoleUnavailable(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    embeds: [
      createGodsEmbed({
        title: "Auto Role Not Saved",
        description: "That role is no longer available in this server. Choose another role and retry.",
        emoji: GODS_EMOJI.settings,
        tone: "error",
      }),
    ],
    ephemeral: true,
  });
}