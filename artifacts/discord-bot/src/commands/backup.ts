import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { listBackupRecords } from "@workspace/db";
import { createServerBackup } from "../backups/backup-service.js";
import {
  previewBackup,
  type RestoreScope,
} from "../backups/restore-service.js";
import type { Command } from "../lib/registry.js";

const scopeChoices = [
  ["full", "Full restore"],
  ["structure", "Roles, channels, settings and emojis"],
  ["messages", "Archived messages only"],
  ["kicked-members", "Kicked-member records only"],
  ["settings", "Server settings only"],
  ["roles", "Roles only"],
  ["channels", "Channels only"],
  ["emojis", "Emojis only"],
] as const;

export const data = new SlashCommandBuilder()
  .setName("backup")
  .setDescription("Create, list, or restore a verified server backup.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand.setName("create").setDescription("Create a server backup now."),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list").setDescription("List this server's saved backups."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("load")
      .setDescription("Preview a backup and confirm its restoration.")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("The backup ID from /backup list.")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("scope")
          .setDescription("What to restore after confirmation.")
          .addChoices(...scopeChoices.map(([value, name]) => ({ name, value }))),
      ),
  );

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(
    interaction.inGuild() &&
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );
}

function summaryText(summary: unknown): string {
  const data =
    summary && typeof summary === "object"
      ? (summary as Record<string, unknown>)
      : {};
  return [
    `${Number(data.roles ?? 0)} roles`,
    `${Number(data.channels ?? 0)} channels`,
    `${Number(data.emojis ?? 0)} emojis`,
    `${Number(data.messages ?? 0)} messages`,
    `${Number(data.attachments ?? 0)} files`,
    `${Number(data.kickedMembers ?? 0)} confirmed kicks`,
    `${Number(data.memberRemovals ?? 0)} member removal events`,
  ].join(" · ");
}

function scopesFor(scope: string): Set<RestoreScope> {
  if (scope === "full") {
    return new Set([
      "settings",
      "roles",
      "channels",
      "emojis",
      "messages",
      "kicked-members",
    ]);
  }
  if (scope === "structure") {
    return new Set(["settings", "roles", "channels", "emojis"]);
  }
  return new Set([scope as RestoreScope]);
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild || !isAdmin(interaction)) {
    await interaction.reply({
      content: "This command is available to server administrators only.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "create") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await createServerBackup(
        interaction.guild,
        interaction.user.id,
        "manual",
        (message) => interaction.editReply({ content: message }).then(() => undefined),
      );
      await interaction.editReply({
        content:
          `Backup completed and verified.\n` +
          `ID: \`${result.backupId}\`\n` +
          `${summaryText(result.summary)}\n` +
          `Warnings: ${result.summary.warnings.length}`,
      });
    } catch (error) {
      await interaction.editReply({
        content: `Backup failed: ${error instanceof Error ? error.message.slice(0, 250) : "unknown error"}`,
      });
    }
    return;
  }

  if (subcommand === "list") {
    await interaction.deferReply({ ephemeral: true });
    const backups = await listBackupRecords(interaction.guild.id, 25).catch(() => null);
    if (!backups) {
      await interaction.editReply(
        "Could not load backups. Confirm the database schema is applied and try again.",
      );
      return;
    }
    if (!backups.length) {
      await interaction.editReply("No verified backups are saved for this server yet.");
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Saved server backups")
      .setDescription(
        backups
          .map((backup) => {
            const time = Math.floor(
              (backup.completedAt ?? backup.createdAt).getTime() / 1000,
            );
            return [
              `**${backup.id}**`,
              `${summaryText(backup.summary)} · <t:${time}:f>`,
              `Created by <@${backup.createdBy}>`,
            ].join("\n");
          })
          .join("\n\n")
          .slice(0, 4000),
      )
      .setFooter({ text: "Only complete backups from this server are shown." });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const backupId = interaction.options.getString("id", true);
  const scope = interaction.options.getString("scope") ?? "full";
  const inspected = await previewBackup(interaction.guild, backupId);
  if (!inspected.ok) {
    await interaction.reply({
      content: `Backup unavailable: ${inspected.reason}`,
      ephemeral: true,
    });
    return;
  }

  const { snapshot, missingChannels, missingRoles, unavailableAttachments } =
    inspected.preview;
  const preview = new EmbedBuilder()
    .setTitle("Restore preview")
    .setDescription(
      [
        `Backup \`${backupId}\` passed its integrity check.`,
        `Scope: **${scopeChoices.find(([value]) => value === scope)?.[1] ?? scope}**`,
        `${snapshot.roles.length} roles · ${snapshot.channels.length} channels · ${snapshot.emojis.length} emojis · ${snapshot.messages.length} messages`,
        `${missingRoles} roles and ${missingChannels} channels are not present by original ID.`,
        `${unavailableAttachments} attachment(s) were not stored in this backup.`,
        "Existing matching roles and channels may be updated. Nothing will be deleted.",
        "Recovered messages receive new Discord IDs and timestamps; original details are shown as metadata.",
      ].join("\n"),
    );
  const confirm = new ButtonBuilder()
    .setCustomId(`backup:confirm:${backupId}:${scope}`)
    .setLabel("Confirm restore")
    .setStyle(ButtonStyle.Danger);
  const cancel = new ButtonBuilder()
    .setCustomId("backup:cancel")
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);
  await interaction.reply({
    embeds: [preview],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel),
    ],
    ephemeral: true,
  });
}

export const command: Command = { data, execute };
