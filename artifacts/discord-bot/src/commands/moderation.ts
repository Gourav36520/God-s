import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { logger } from "../lib/logger.js";
import { securityManager } from "../lib/registry.js";
import {
  deny,
  fetchTargetMember,
  memberHierarchyIssue,
  requireAdminManagerOrOwner,
  requireConfiguredRoleMember,
  requireServerOwner,
  resolveModerationContext,
} from "../moderation/permissions.js";

export const warn = {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Record a warning for a server member")
    .addUserOption((option) =>
      option.setName("member").setDescription("The member to warn").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the member is being warned")
        .setMaxLength(500)
        .setRequired(false),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = await resolveModerationContext(interaction);
    if (!context) return;
    if (
      !(await requireConfiguredRoleMember(
        interaction,
        context,
        "warnRoleId",
        "Warn",
      ))
    ) {
      return;
    }

    const user = interaction.options.getUser("member", true);
    const target = await fetchTargetMember(context, user.id);
    if (!target) {
      await deny(interaction, "That member is no longer in this server.");
      return;
    }
    const hierarchyIssue = memberHierarchyIssue(context, target);
    if (hierarchyIssue) {
      await deny(interaction, hierarchyIssue);
      return;
    }

    const reason = interaction.options.getString("reason")?.trim() || "No reason provided";
    const config = securityManager.getConfig(context.guild.id);
    const previousCount = Math.max(
      0,
      Math.trunc(config.manualWarningCounts[target.id] ?? 0),
    );
    const nextCount = previousCount + 1;
    const triggersTimeout = nextCount % 3 === 0;

    if (
      triggersTimeout &&
      (!context.bot.permissions.has(PermissionFlagsBits.ModerateMembers) ||
        !target.moderatable)
    ) {
      await deny(
        interaction,
        "This is the third warning, but the bot cannot timeout that member. The warning was not recorded.",
      );
      return;
    }

    await securityManager.updateConfig(context.guild.id, {
      manualWarningCounts: {
        ...config.manualWarningCounts,
        [target.id]: nextCount,
      },
    });

    if (triggersTimeout) {
      try {
        await target.timeout(
          10 * 60 * 1_000,
          `Third manual warning by ${interaction.user.tag}: ${reason}`,
        );
      } catch {
        const latest = securityManager.getConfig(context.guild.id);
        await securityManager
          .updateConfig(context.guild.id, {
            manualWarningCounts: {
              ...latest.manualWarningCounts,
              [target.id]: previousCount,
            },
          })
          .catch((rollbackError: unknown) => {
            logger.error(
              `Failed to roll back manual warning count guild=${context.guild.id} target=${target.id}:`,
              rollbackError,
            );
          });
        await deny(
          interaction,
          "The warning was not recorded because the bot could not apply the required 10-minute timeout.",
        );
        return;
      }
    }

    logger.info(
      `Manual warning recorded guild=${context.guild.id} target=${target.id} count=${nextCount} actor=${context.actor.id}`,
    );
    await interaction.reply({
      content: triggersTimeout
        ? `${target} received warning ${nextCount}; the third-warning rule applied a 10-minute timeout. Reason: ${reason}`
        : `${target} received warning ${nextCount}. Reason: ${reason}`,
      ephemeral: true,
    });
  },
};

export const timeout = {
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a server member")
    .addUserOption((option) =>
      option.setName("member").setDescription("The member to timeout").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription("Timeout length in minutes (maximum 28 days)")
        .setMinValue(1)
        .setMaxValue(40_320)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the member is being timed out")
        .setMaxLength(500)
        .setRequired(false),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = await resolveModerationContext(interaction);
    if (!context) return;
    if (
      !(await requireConfiguredRoleMember(
        interaction,
        context,
        "timeoutRoleId",
        "Timeout",
      ))
    ) {
      return;
    }
    if (!context.bot.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await deny(interaction, "The bot needs the Moderate Members permission to do that.");
      return;
    }

    const user = interaction.options.getUser("member", true);
    const target = await fetchTargetMember(context, user.id);
    if (!target) {
      await deny(interaction, "That member is no longer in this server.");
      return;
    }
    const hierarchyIssue = memberHierarchyIssue(context, target);
    if (hierarchyIssue) {
      await deny(interaction, hierarchyIssue);
      return;
    }
    if (!target.moderatable) {
      await deny(interaction, "The bot cannot timeout that member.");
      return;
    }

    const minutes = interaction.options.getInteger("minutes", true);
    const reason = interaction.options.getString("reason")?.trim() || "No reason provided";
    await target.timeout(minutes * 60 * 1_000, reason);
    logger.info(
      `Manual timeout applied guild=${context.guild.id} target=${target.id} minutes=${minutes} actor=${context.actor.id}`,
    );
    await interaction.reply({
      content: `${target} was timed out for ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      ephemeral: true,
    });
  },
};

export const kick = {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a server member (server owner only)")
    .addUserOption((option) =>
      option.setName("member").setDescription("The member to kick").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Reason for the kick").setMaxLength(500),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = await resolveModerationContext(interaction);
    if (!context || !(await requireServerOwner(interaction, context))) return;
    if (!context.bot.permissions.has(PermissionFlagsBits.KickMembers)) {
      await deny(interaction, "The bot needs the Kick Members permission to do that.");
      return;
    }
    const user = interaction.options.getUser("member", true);
    const target = await fetchTargetMember(context, user.id);
    if (!target) {
      await deny(interaction, "That member is no longer in this server.");
      return;
    }
    const hierarchyIssue = memberHierarchyIssue(context, target);
    if (hierarchyIssue) {
      await deny(interaction, hierarchyIssue);
      return;
    }
    if (!target.kickable) {
      await deny(interaction, "The bot cannot kick that member.");
      return;
    }
    const reason = interaction.options.getString("reason")?.trim() || "No reason provided";
    await target.kick(reason);
    logger.info(
      `Owner kick guild=${context.guild.id} target=${target.id} actor=${context.actor.id}`,
    );
    await interaction.reply({
      content: `${target.user.tag} was kicked.`,
      ephemeral: true,
    });
  },
};

export const ban = {
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a server member (server owner only)")
    .addUserOption((option) =>
      option.setName("member").setDescription("The member to ban").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Reason for the ban").setMaxLength(500),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = await resolveModerationContext(interaction);
    if (!context || !(await requireServerOwner(interaction, context))) return;
    if (!context.bot.permissions.has(PermissionFlagsBits.BanMembers)) {
      await deny(interaction, "The bot needs the Ban Members permission to do that.");
      return;
    }
    const user = interaction.options.getUser("member", true);
    const target = await fetchTargetMember(context, user.id);
    if (!target) {
      await deny(interaction, "That member is no longer in this server.");
      return;
    }
    const hierarchyIssue = memberHierarchyIssue(context, target);
    if (hierarchyIssue) {
      await deny(interaction, hierarchyIssue);
      return;
    }
    if (!target.bannable) {
      await deny(interaction, "The bot cannot ban that member.");
      return;
    }
    const reason = interaction.options.getString("reason")?.trim() || "No reason provided";
    await target.ban({ reason });
    logger.info(
      `Owner ban guild=${context.guild.id} target=${target.id} actor=${context.actor.id}`,
    );
    await interaction.reply({
      content: `${target.user.tag} was banned.`,
      ephemeral: true,
    });
  },
};

export const unban = {
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a Discord user (server owner only)")
    .addStringOption((option) =>
      option
        .setName("user_id")
        .setDescription("The banned user's Discord ID")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Reason for the unban").setMaxLength(500),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = await resolveModerationContext(interaction);
    if (!context || !(await requireServerOwner(interaction, context))) return;
    if (!context.bot.permissions.has(PermissionFlagsBits.BanMembers)) {
      await deny(interaction, "The bot needs the Ban Members permission to do that.");
      return;
    }

    const userId = interaction.options.getString("user_id", true).trim();
    if (!/^\d{17,20}$/.test(userId)) {
      await deny(interaction, "Enter a valid Discord user ID.");
      return;
    }
    const banRecord = await context.guild.bans.fetch(userId).catch(() => null);
    if (!banRecord) {
      await deny(interaction, "That user is not banned from this server.");
      return;
    }
    const reason = interaction.options.getString("reason")?.trim() || "No reason provided";
    await context.guild.bans.remove(userId, reason);
    logger.info(
      `Owner unban guild=${context.guild.id} target=${userId} actor=${context.actor.id}`,
    );
    await interaction.reply({
      content: `${banRecord.user.tag} was unbanned.`,
      ephemeral: true,
    });
  },
};

export const nick = {
  data: new SlashCommandBuilder()
    .setName("nick")
    .setDescription("Change a member's server nickname")
    .addUserOption((option) =>
      option.setName("member").setDescription("The member").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("nickname")
        .setDescription("New nickname; enter reset to clear it")
        .setMinLength(1)
        .setMaxLength(32)
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = await resolveModerationContext(interaction);
    if (!context || !(await requireAdminManagerOrOwner(interaction, context))) return;
    if (!context.bot.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      await deny(interaction, "The bot needs the Manage Nicknames permission to do that.");
      return;
    }

    const user = interaction.options.getUser("member", true);
    const target = await fetchTargetMember(context, user.id);
    if (!target) {
      await deny(interaction, "That member is no longer in this server.");
      return;
    }
    const hierarchyIssue = memberHierarchyIssue(context, target);
    if (hierarchyIssue) {
      await deny(interaction, hierarchyIssue);
      return;
    }
    if (!target.manageable) {
      await deny(interaction, "The bot cannot change that member's nickname.");
      return;
    }

    const requestedNickname = interaction.options.getString("nickname", true).trim();
    const nickname =
      requestedNickname.toLowerCase() === "reset" ? null : requestedNickname;
    await target.setNickname(
      nickname,
      `Nickname changed by ${interaction.user.tag} (${interaction.user.id})`,
    );
    logger.info(
      `Nickname changed guild=${context.guild.id} target=${target.id} actor=${context.actor.id}`,
    );
    await interaction.reply({
      content: nickname
        ? `Changed ${target.user.tag}'s nickname to **${nickname}**.`
        : `Reset ${target.user.tag}'s nickname.`,
      ephemeral: true,
    });
  },
};
