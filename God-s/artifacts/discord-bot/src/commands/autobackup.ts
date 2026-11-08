import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getBackupCount } from "@workspace/db";
import {
  createServerBackup,
  getBackupConfig,
  setBackupConfig,
  storageStatus,
} from "../backups/backup-service.js";
import type { Command } from "../lib/registry.js";

const ON_EMOJI = { id: "1566034940729233560", name: "On" };
const OFF_EMOJI = { id: "1566035067602735217", name: "Off" };

export const data = new SlashCommandBuilder()
  .setName("autobackup")
  .setDescription("Manage this server's automatic backups and archive settings.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand.setName("settings").setDescription("Post the persistent backup controls."),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("status").setDescription("View schedule, storage, and recent results."),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("configure")
      .setDescription("Set the automatic backup interval and retention.")
      .addIntegerOption((option) =>
        option
          .setName("interval-minutes")
          .setDescription("Time between automatic backups (15 to 10080 minutes).")
          .setMinValue(15)
          .setMaxValue(10080)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("retention")
          .setDescription("Number of verified backups to keep (1 to 100).")
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("alert-channel")
          .setDescription("Optional channel for automatic backup failure alerts.")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("run").setDescription("Create and verify a backup now."),
  );

function onState(on: boolean) {
  return on ? ON_EMOJI : OFF_EMOJI;
}

function prettyTime(value: Date | null): string {
  return value ? `<t:${Math.floor(value.getTime() / 1000)}:f>` : "Not scheduled";
}

export function autobackupComponents(
  config: Awaited<ReturnType<typeof getBackupConfig>>,
) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("autobackup:toggle:auto")
      .setLabel("Automatic backups")
      .setEmoji(onState(config.autoBackupOn))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("autobackup:toggle:archive")
      .setLabel("Message archive")
      .setEmoji(onState(config.archiveOn))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("autobackup:toggle:kicks")
      .setLabel("Kicked-member tracking")
      .setEmoji(onState(config.kickTrackingOn))
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

export async function autobackupPanelText(guildId: string): Promise<string> {
  const [config, storage, backupCount] = await Promise.all([
    getBackupConfig(guildId),
    storageStatus(guildId),
    getBackupCount(guildId),
  ]);
  const storageMiB = (storage.bytes / (1024 * 1024)).toFixed(1);
  return [
    "**God's Bot backup controls**",
    `Scheduled backups: **${config.autoBackupOn ? "ON" : "OFF"}** · interval ${config.intervalMinutes} minutes · retain ${config.retentionCount}`,
    `Message archive: **${config.archiveOn ? "ON" : "OFF"}** · latest 100 per supported text channel`,
    `Kicked-member tracking: **${config.kickTrackingOn ? "ON" : "OFF"}**`,
    `Last successful backup: ${prettyTime(config.lastSuccessAt)}`,
    `Next scheduled backup: ${prettyTime(config.nextRunAt)}`,
    `Verified backups: ${backupCount} · archived messages: ${storage.archiveCount} · stored files: ${storageMiB} MiB`,
    `Failure status: ${config.lastFailure ? config.lastFailure.slice(0, 240) : "No recent failure"}`,
    "Only administrators can change these saved settings. Buttons show the current database state.",
  ].join("\n");
}

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(
    interaction.inGuild() &&
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );
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

  const action = interaction.options.getSubcommand();
  if (action === "settings") {
    const config = await getBackupConfig(interaction.guild.id);
    await interaction.reply({
      content: await autobackupPanelText(interaction.guild.id),
      components: autobackupComponents(config),
      ephemeral: false,
    });
    return;
  }

  if (action === "status") {
    await interaction.reply({
      content: await autobackupPanelText(interaction.guild.id),
      ephemeral: true,
    });
    return;
  }

  if (action === "configure") {
    const current = await getBackupConfig(interaction.guild.id);
    const intervalMinutes = interaction.options.getInteger("interval-minutes", true);
    const retentionCount = interaction.options.getInteger("retention", true);
    const channel = interaction.options.getChannel("alert-channel");
    const now = new Date();
    const nextRunAt = current.autoBackupOn
      ? new Date(now.getTime() + intervalMinutes * 60_000)
      : null;
    await setBackupConfig(interaction.guild.id, {
      intervalMinutes,
      retentionCount,
      ...(channel ? { notificationChannelId: channel.id } : {}),
      nextRunAt,
      updatedBy: interaction.user.id,
    });
    await interaction.reply({
      content: `Saved. Interval: ${intervalMinutes} minutes; retention: ${retentionCount}.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await createServerBackup(
      interaction.guild,
      interaction.user.id,
      "manual",
      (message) => interaction.editReply({ content: message }).then(() => undefined),
    );
    await setBackupConfig(interaction.guild.id, {
      lastSuccessAt: new Date(),
      lastFailureAt: null,
      lastFailure: null,
      updatedBy: interaction.user.id,
    });
    await interaction.editReply(
      `Manual backup completed and verified. ID: \`${result.backupId}\` · ${result.summary.messages} messages.`,
    );
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.slice(0, 220) : "Unknown backup failure.";
    await setBackupConfig(interaction.guild.id, {
      lastFailureAt: new Date(),
      lastFailure: reason,
      updatedBy: interaction.user.id,
    }).catch(() => undefined);
    await interaction.editReply(`Backup failed: ${reason}`);
  }
}

export const command: Command = { data, execute };
