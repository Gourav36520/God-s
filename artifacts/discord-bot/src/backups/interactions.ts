import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  claimBackupInteractionSession,
  deleteExpiredBackupSessions,
  getBackupInteractionSession,
  getKickedMemberRecovery,
  listArchivedMessageChannels,
  listArchivedMessages,
  listBackupRecords,
  listKickedMemberRecoveries,
  setKickedMemberInvite,
  setKickedMemberRecoveryStatus,
  updateBackupInteractionSession,
} from "@workspace/db";
import { getBackupConfig, setBackupConfig } from "./backup-service.js";
import {
  listAuditRecoveryCandidates,
  restoreAuditLogResources,
  validAuditRecoveryCandidates,
} from "./audit-recovery.js";
import {
  previewBackup,
  restoreArchivedChannelMessages,
  restoreServerBackup,
  type RestoreScope,
} from "./restore-service.js";
import { autobackupComponents, autobackupPanelText } from "../commands/autobackup.js";
import { logger } from "../lib/logger.js";

type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

const BACKUP_LOAD_SCOPES: RestoreScope[] = [
  "settings",
  "roles",
  "channels",
  "emojis",
  "messages",
  "kicked-members",
];
export const RECOVERY_BACKUP_SCOPES: RestoreScope[] = [
  "settings",
  "roles",
  "channels",
  "emojis",
  "messages",
  "kicked-members",
];
const activeManualRestores = new Set<string>();

export function isBackupComponent(customId: string): boolean {
  return (
    customId.startsWith("autobackup:") ||
    customId.startsWith("backup:") ||
    customId.startsWith("gods:recover:")
  );
}

function isAdmin(interaction: ComponentInteraction): boolean {
  return Boolean(
    interaction.guildId &&
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator),
  );
}

async function deny(interaction: ComponentInteraction, message: string): Promise<void> {
  await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
}

async function authorizedSession(
  interaction: ComponentInteraction,
  sessionId: string,
) {
  if (!interaction.guildId || !isAdmin(interaction)) {
    await deny(interaction, "Only a server administrator can use this recovery panel.");
    return null;
  }
  const session = await getBackupInteractionSession(interaction.guildId, sessionId);
  if (!session || session.kind !== "recovery") {
    await deny(interaction, "This recovery panel expired. Run `/recover` to start again.");
    return null;
  }
  if (session.userId !== interaction.user.id) {
    await deny(interaction, "This recovery panel belongs to another administrator.");
    return null;
  }
  return session;
}

function rows(content: string, menu: StringSelectMenuBuilder) {
  return {
    content,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

function scopesMenu(sessionId: string, selected: string[]) {
  const options = [
    ["settings", "Server settings"],
    ["roles", "Roles"],
    ["channels", "Channels and permissions"],
    ["emojis", "Emojis"],
    ["messages", "Archived messages"],
    ["kicked-members", "Kicked-member records"],
  ] as const;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`gods:recover:scopes:${sessionId}`)
    .setPlaceholder("Choose one or more data types")
    .setMinValues(1)
    .setMaxValues(options.length)
    .addOptions(
      options.map(([value, label]) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setValue(value)
          .setDefault(selected.includes(value)),
      ),
    );
  const preview = new ButtonBuilder()
    .setCustomId(`gods:recover:preview:${sessionId}`)
    .setLabel("Preview selected data")
    .setStyle(ButtonStyle.Primary);
  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    new ActionRowBuilder<ButtonBuilder>().addComponents(preview),
  ];
}

function recoveryButtons(buttons: ButtonBuilder[]) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

function reportText(report: {
  restored: string[];
  skipped: string[];
  failed: string[];
  warnings: string[];
}): string {
  const lines = [
    `Restored: ${report.restored.length}`,
    `Skipped: ${report.skipped.length}`,
    `Failed: ${report.failed.length}`,
    ...report.restored.slice(0, 12).map((value) => `• ${value}`),
    ...report.skipped.slice(0, 6).map((value) => `Skipped: ${value}`),
    ...report.failed.slice(0, 6).map((value) => `Failed: ${value}`),
    ...report.warnings.slice(0, 5).map((value) => `Note: ${value}`),
  ];
  return lines.join("\n").slice(0, 3900);
}

async function handleTargetSelect(
  interaction: StringSelectMenuInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  await deleteExpiredBackupSessions().catch(() => undefined);
  const target = interaction.values[0];
  if (target === "backup") {
    let backups;
    try {
      backups = await listBackupRecords(interaction.guild.id, 25);
    } catch {
      await interaction.update({
        content: "Could not read saved backups. Check the database connection and try again.",
        components: [],
      });
      return;
    }
    if (!backups.length) {
      await interaction.update({
        content: "No verified server backups are available.",
        components: [],
      });
      return;
    }
    await updateBackupInteractionSession(interaction.guild.id, sessionId, {
      step: "backup-list",
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`gods:recover:backup:${sessionId}`)
      .setPlaceholder("Select a verified backup")
      .addOptions(
        backups.map((backup, index) => {
          const summary =
            backup.summary && typeof backup.summary === "object"
              ? (backup.summary as Record<string, unknown>)
              : {};
          return {
            label: `Backup ${index + 1} · ${backup.id.slice(0, 8)}`,
            value: backup.id,
            description:
              `${Number(summary.channels ?? 0)} channels · ${Number(summary.messages ?? 0)} messages · ` +
              `${(backup.completedAt ?? backup.createdAt).toISOString().slice(0, 10)}`,
          };
        }),
      );
    await interaction.update(
      rows("Select a verified backup to inspect before choosing what to restore.", menu),
    );
    return;
  }

  if (target === "archive") {
    let channels;
    try {
      channels = await listArchivedMessageChannels(interaction.guild.id);
    } catch {
      await interaction.update({
        content: "Could not read the message archive. Check the database connection and try again.",
        components: [],
      });
      return;
    }
    if (!channels.length) {
      await interaction.update({
        content: "There are no archived messages available for this server.",
        components: [],
      });
      return;
    }
    await updateBackupInteractionSession(interaction.guild.id, sessionId, {
      step: "archive-channel",
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`gods:recover:archive:${sessionId}`)
      .setPlaceholder("Choose a channel archive")
      .addOptions(
        channels.map((channel) => ({
          label: channel.channelName.slice(0, 100),
          value: channel.channelId,
          description: `${channel.messageCount} archived message(s)`,
        })),
      );
    await interaction.update(rows("Select the channel whose saved messages you want to recover.", menu));
    return;
  }

  if (target === "audit") {
    const result = await listAuditRecoveryCandidates(interaction.guild);
    if (!result.ok) {
      await interaction.update({
        content: result.reason,
        components: [],
      });
      return;
    }
    if (!result.candidates.length) {
      await interaction.update({
        content: [
          "No recoverable deleted channels or roles were found in the available audit logs.",
          ...result.warnings,
        ].join("\n"),
        components: [],
      });
      return;
    }
    await updateBackupInteractionSession(interaction.guild.id, sessionId, {
      step: "audit-list",
      auditWarnings: result.warnings,
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`gods:recover:audit:${sessionId}`)
      .setPlaceholder("Select deleted channels or roles")
      .setMinValues(1)
      .setMaxValues(result.candidates.length)
      .addOptions(
        result.candidates.map((candidate) => ({
          label: `${candidate.data.kind === "role" ? "Role" : "Channel"} · ${candidate.data.name}`.slice(0, 100),
          value: candidate.auditEntryId,
          description: `Deleted ${candidate.deletedAt.slice(0, 16)} UTC${candidate.executorId ? ` · executor ${candidate.executorId}` : " · executor unavailable"}`.slice(0, 100),
        })),
      );
    await interaction.update(
      rows(
        [
          "Select audit-log entries to preview. This recovery does not require a saved backup.",
          ...result.warnings,
        ].join("\n"),
        menu,
      ),
    );
    return;
  }

  if (target === "kicks") {
    let kicks;
    try {
      kicks = await listKickedMemberRecoveries(interaction.guild.id, 25);
    } catch {
      await interaction.update({
        content: "Could not read kick-recovery records. Check the database connection and try again.",
        components: [],
      });
      return;
    }
    if (!kicks.length) {
      await interaction.update({
        content: "No audit-log-confirmed kick records are available.",
        components: [],
      });
      return;
    }
    await updateBackupInteractionSession(interaction.guild.id, sessionId, {
      step: "kick-select",
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`gods:recover:kick:${sessionId}`)
      .setPlaceholder("Select a recorded kick")
      .addOptions(
        kicks.map((kick) => ({
          label: `${kick.username} · ${kick.memberId}`.slice(0, 100),
          value: String(kick.id),
          description: `Removed ${kick.kickedAt.toISOString().slice(0, 16)} UTC · ${kick.rejoinedAt ? "rejoined" : "not rejoined"}`,
        })),
      );
    await interaction.update(rows("Only removals matched to a Discord kick audit entry are listed.", menu));
  }
}

async function handleArchiveSelect(
  interaction: StringSelectMenuInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  const channelId = interaction.values[0];
  const messages = await listArchivedMessages(interaction.guild.id, channelId);
  if (!messages.length) {
    await interaction.update({ content: "That channel no longer has archived messages.", components: [] });
    return;
  }
  const channelName = messages[0]?.channelName ?? channelId;
  await updateBackupInteractionSession(interaction.guild.id, sessionId, {
    step: "confirm-archive",
    channelId,
  });
  const embed = new EmbedBuilder()
    .setTitle("Archived message recovery preview")
    .setDescription(
      [
        `Channel: **#${channelName}**`,
        `Messages available: **${messages.length}**`,
        `Deleted messages observed: ${messages.filter((message) => message.deletedAt).length}`,
        "Recovered messages will be reposted with original author/time as metadata; original Discord IDs, timestamps, and reply links cannot be recreated.",
      ].join("\n"),
    );
  await interaction.update({
    content: "",
    embeds: [embed],
    components: recoveryButtons([
      new ButtonBuilder()
        .setCustomId(`gods:recover:confirm-archive:${sessionId}`)
        .setLabel("Confirm message recovery")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`gods:recover:cancel:${sessionId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ]),
  });
}

async function handleBackupSelect(
  interaction: StringSelectMenuInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  const backupId = interaction.values[0];
  const preview = await previewBackup(interaction.guild, backupId);
  if (!preview.ok) {
    await interaction.update({ content: `Backup unavailable: ${preview.reason}`, components: [] });
    return;
  }
  await updateBackupInteractionSession(interaction.guild.id, sessionId, {
    step: "scopes",
    backupId,
    scopes: RECOVERY_BACKUP_SCOPES,
  });
  const snapshot = preview.preview.snapshot;
  await interaction.update({
    content: [
      `Backup \`${backupId}\` passed integrity verification.`,
      `${snapshot.roles.length} roles · ${snapshot.channels.length} channels · ${snapshot.emojis.length} emojis · ${snapshot.messages.length} messages.`,
      `${snapshot.kickedMembers.length} confirmed kicks · ${snapshot.memberRemovals?.length ?? 0} tracked member removals.`,
      `${preview.preview.unavailableAttachments} attachment(s) have no stored file.`,
      "Select one or more data types, then preview the changes before confirming.",
    ].join("\n"),
    components: scopesMenu(sessionId, RECOVERY_BACKUP_SCOPES),
  });
}

async function handleAuditSelect(
  interaction: StringSelectMenuInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  const result = await listAuditRecoveryCandidates(interaction.guild);
  if (!result.ok) {
    await interaction.update({ content: result.reason, components: [] });
    return;
  }
  const selectedIds = new Set(interaction.values);
  const selected = result.candidates.filter((candidate) =>
    selectedIds.has(candidate.auditEntryId),
  );
  if (!selected.length || selected.length !== selectedIds.size) {
    await interaction.update({
      content: "One or more audit entries are no longer available. Run `/recover` again.",
      components: [],
    });
    return;
  }
  await updateBackupInteractionSession(interaction.guild.id, sessionId, {
    step: "audit-preview",
    auditCandidates: selected,
    auditWarnings: result.warnings,
  });

  const roleCount = selected.filter((candidate) => candidate.data.kind === "role").length;
  const channelCount = selected.length - roleCount;
  const details = selected.map((candidate) => {
    const kind = candidate.data.kind === "role" ? "Role" : "Channel";
    const executor = candidate.executorId
      ? `executor ID \`${candidate.executorId}\``
      : "executor not recorded";
    const unavailable =
      candidate.data.warnings.length > 0
        ? `; ${candidate.data.warnings.join("; ")}`
        : "";
    return `• ${kind} **${candidate.data.name}** · deleted <t:${Math.floor(new Date(candidate.deletedAt).getTime() / 1000)}:f> · ${executor}${unavailable}`;
  });
  const embed = new EmbedBuilder()
    .setTitle("Audit-log recovery preview")
    .setDescription(
      [
        `${roleCount} role(s) · ${channelCount} channel(s) selected.`,
        ...details,
        ...result.warnings.map((warning) => `Note: ${warning}`),
        "Only new resources will be created. Existing roles and channels will not be changed or deleted.",
        "Discord may not retain every original setting. Review the report after confirmation.",
      ]
        .join("\n")
        .slice(0, 4000),
    );
  await interaction.update({
    content: "",
    embeds: [embed],
    components: recoveryButtons([
      new ButtonBuilder()
        .setCustomId(`gods:recover:confirm-audit:${sessionId}`)
        .setLabel("Confirm recovery")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`gods:recover:cancel:${sessionId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ]),
  });
}

async function handleScopeSelect(
  interaction: StringSelectMenuInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  const valid = interaction.values.filter((value): value is RestoreScope =>
    RECOVERY_BACKUP_SCOPES.includes(value as RestoreScope),
  );
  if (!valid.length) {
    await deny(interaction, "Select at least one recovery item.");
    return;
  }
  await updateBackupInteractionSession(interaction.guild.id, sessionId, {
    ...session.state,
    step: "scopes",
    scopes: valid,
  });
  await interaction.update({
    content: `Selected: ${valid.join(", ")}. Use the preview button before confirming.`,
    components: scopesMenu(sessionId, valid),
  });
}

async function showRestorePreview(
  interaction: ButtonInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  const backupId = String(session.state.backupId ?? "");
  const scopes = Array.isArray(session.state.scopes)
    ? session.state.scopes.filter((value): value is RestoreScope =>
        RECOVERY_BACKUP_SCOPES.includes(value as RestoreScope),
      )
    : [];
  if (!backupId || !scopes.length) {
    await deny(interaction, "This recovery selection is incomplete. Run `/recover` again.");
    return;
  }
  const preview = await previewBackup(interaction.guild, backupId);
  if (!preview.ok) {
    await interaction.update({ content: `Backup unavailable: ${preview.reason}`, components: [] });
    return;
  }
  await updateBackupInteractionSession(interaction.guild.id, sessionId, {
    ...session.state,
    step: "confirm-backup",
    scopes,
  });
  const embed = new EmbedBuilder()
    .setTitle("Recovery confirmation")
    .setDescription(
      [
        `Backup: \`${backupId}\``,
        `Selected: ${scopes.join(", ")}`,
        `Member removals: ${preview.preview.snapshot.memberRemovals?.length ?? 0} recorded; only audit-confirmed kicks are eligible for invite recovery.`,
        `Missing by original ID: ${preview.preview.missingRoles} roles and ${preview.preview.missingChannels} channels.`,
        `Unavailable attachment files: ${preview.preview.unavailableAttachments}.`,
        "Existing matching roles/channels and selected server settings may be updated. Nothing will be deleted.",
        "Messages will be reposted with new Discord IDs/timestamps and original details labeled as metadata.",
        "Confirm only if these changes are intended.",
      ].join("\n"),
    );
  await interaction.update({
    content: "",
    embeds: [embed],
    components: recoveryButtons([
      new ButtonBuilder()
        .setCustomId(`gods:recover:confirm-backup:${sessionId}`)
        .setLabel("Confirm recovery")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`gods:recover:cancel:${sessionId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ]),
  });
}

async function handleKickSelect(
  interaction: StringSelectMenuInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  const id = Number(interaction.values[0]);
  const kick = Number.isSafeInteger(id)
    ? await getKickedMemberRecovery(interaction.guild.id, id)
    : null;
  if (!kick) {
    await interaction.update({ content: "Kick record unavailable.", components: [] });
    return;
  }
  await updateBackupInteractionSession(interaction.guild.id, sessionId, {
    step: "kick-preview",
    kickId: id,
  });
  const embed = new EmbedBuilder()
    .setTitle("Kicked-member recovery preview")
    .setDescription(
      [
        `Member: **${kick.username}** (\`${kick.memberId}\`)`,
        `Kick recorded: <t:${Math.floor(kick.kickedAt.getTime() / 1000)}:f>`,
        `Audit-log executor: ${kick.executorId ? `<@${kick.executorId}>` : "Not available; no executor will be guessed"}`,
        `Evidence: ${JSON.stringify(kick.evidence).slice(0, 800)}`,
        `Status: ${kick.rejoinedAt ? "Member has rejoined" : kick.deliveryStatus}`,
        "The bot will not unban anyone. If the member remains banned, an administrator must handle that separately.",
      ].join("\n"),
    );
  await interaction.update({
    content: "",
    embeds: [embed],
    components: recoveryButtons([
      new ButtonBuilder()
        .setCustomId(`gods:recover:kick-dm:${sessionId}`)
        .setLabel("Confirm and DM invite")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`gods:recover:kick-admin:${sessionId}`)
        .setLabel("Confirm and show invite")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`gods:recover:cancel:${sessionId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ]),
  });
}

async function completeBackupRestore(
  interaction: ButtonInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  if (session.state.step !== "confirm-backup") {
    await deny(interaction, "This confirmation is no longer active.");
    return;
  }
  const backupId = String(session.state.backupId ?? "");
  const scopes = Array.isArray(session.state.scopes)
    ? session.state.scopes.filter((value): value is RestoreScope =>
        RECOVERY_BACKUP_SCOPES.includes(value as RestoreScope),
      )
    : [];
  const claimed = await claimBackupInteractionSession(
    interaction.guild.id,
    sessionId,
    interaction.user.id,
    "confirm-backup",
    { ...session.state, step: "processing" },
  );
  if (!claimed) {
    await deny(interaction, "This recovery is expired or already being processed.");
    return;
  }
  await interaction.deferUpdate();
  const report = await restoreServerBackup(
    interaction.guild,
    backupId,
    new Set(scopes),
  );
  await updateBackupInteractionSession(interaction.guild.id, sessionId, {
    ...session.state,
    step: "complete",
  }).catch(() => undefined);
  await interaction.editReply({
    content: `Recovery report\n${reportText(report)}`,
    embeds: [],
    components: [],
  });
}

async function completeArchiveRestore(
  interaction: ButtonInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  if (session.state.step !== "confirm-archive") {
    await deny(interaction, "This confirmation is no longer active.");
    return;
  }
  const channelId = String(session.state.channelId ?? "");
  const claimed = await claimBackupInteractionSession(
    interaction.guild.id,
    sessionId,
    interaction.user.id,
    "confirm-archive",
    { ...session.state, step: "processing" },
  );
  if (!claimed) {
    await deny(interaction, "This recovery is expired or already being processed.");
    return;
  }
  await interaction.deferUpdate();
  const report = await restoreArchivedChannelMessages(interaction.guild, channelId);
  await updateBackupInteractionSession(interaction.guild.id, sessionId, {
    ...session.state,
    step: "complete",
  }).catch(() => undefined);
  await interaction.editReply({
    content: `Archived-message recovery report\n${reportText(report)}`,
    embeds: [],
    components: [],
  });
}

async function completeAuditRecovery(
  interaction: ButtonInteraction,
  sessionId: string,
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  if (session.state.step !== "audit-preview") {
    await deny(interaction, "This confirmation is no longer active.");
    return;
  }
  const candidates = validAuditRecoveryCandidates(session.state.auditCandidates);
  if (!candidates.length) {
    await deny(interaction, "The audit recovery selection is empty. Run `/recover` again.");
    return;
  }
  const claimed = await claimBackupInteractionSession(
    interaction.guild.id,
    sessionId,
    interaction.user.id,
    "audit-preview",
    { ...session.state, step: "processing" },
  );
  if (!claimed) {
    await deny(interaction, "This recovery is expired or already being processed.");
    return;
  }
  await interaction.deferUpdate();
  const report = await restoreAuditLogResources(interaction.guild, candidates);
  await updateBackupInteractionSession(interaction.guild.id, sessionId, {
    ...session.state,
    step: "complete",
  }).catch(() => undefined);
  await interaction.editReply({
    content: `Audit-log recovery report\n${reportText(report)}`,
    embeds: [],
    components: [],
  });
}

async function completeKickRecovery(
  interaction: ButtonInteraction,
  sessionId: string,
  delivery: "dm" | "admin",
): Promise<void> {
  const session = await authorizedSession(interaction, sessionId);
  if (!session || !interaction.guild) return;
  if (session.state.step !== "kick-preview") {
    await deny(interaction, "This confirmation is no longer active.");
    return;
  }
  const id = Number(session.state.kickId);
  const kick = Number.isSafeInteger(id)
    ? await getKickedMemberRecovery(interaction.guild.id, id)
    : null;
  if (!kick) {
    await deny(interaction, "Kick record unavailable.");
    return;
  }
  const claimed = await claimBackupInteractionSession(
    interaction.guild.id,
    sessionId,
    interaction.user.id,
    "kick-preview",
    { ...session.state, step: "processing" },
  );
  if (!claimed) {
    await deny(interaction, "This recovery is expired or already being processed.");
    return;
  }
  await interaction.deferUpdate();
  const memberPresent =
    interaction.guild.members.cache.has(kick.memberId) ||
    Boolean(
      await interaction.guild.members.fetch(kick.memberId).catch(() => null),
    );
  if (kick.rejoinedAt || memberPresent) {
    await updateBackupInteractionSession(interaction.guild.id, sessionId, {
      ...session.state,
      step: "complete",
    }).catch(() => undefined);
    await interaction.editReply({
      content: "This member has already rejoined. No invite was created.",
      embeds: [],
      components: [],
    });
    return;
  }

  let inviteCode: string | null = null;
  try {
    const botMember =
      interaction.guild.members.me ??
      (await interaction.guild.members.fetchMe().catch(() => null));
    const inviteChannel = botMember
      ? [...interaction.guild.channels.cache.values()].find(
          (channel) =>
            channel.isTextBased() &&
            "createInvite" in channel &&
            channel
              .permissionsFor(interaction.guild!.roles.everyone)
              ?.has(PermissionFlagsBits.ViewChannel) &&
            channel
              .permissionsFor(botMember)
              ?.has(PermissionFlagsBits.CreateInstantInvite),
        )
      : null;
    if (!inviteChannel || !("createInvite" in inviteChannel)) {
      throw new Error("The bot needs Create Instant Invite in a text channel.");
    }
    const invite = await (inviteChannel as never as {
      createInvite: (options: Record<string, unknown>) => Promise<{ code: string }>;
    }).createInvite({
      maxAge: 7 * 24 * 60 * 60,
      maxUses: 1,
      unique: true,
      reason: "Administrator-confirmed kicked-member recovery",
    });
    inviteCode = invite.code;
    await setKickedMemberInvite(
      interaction.guild.id,
      kick.id,
      invite.code,
      "created",
      false,
    );
    let status = "provided_to_admin";
    let deliveredToMember = false;
    if (delivery === "dm") {
      try {
        const user = await interaction.client.users.fetch(kick.memberId);
        await user.send(
          `You have a one-use invitation to rejoin ${interaction.guild.name}: https://discord.gg/${invite.code}\n` +
            "This invitation does not remove any existing server ban.",
        );
        status = "dm_delivered";
        deliveredToMember = true;
      } catch {
        status = "dm_failed";
      }
    }
    await setKickedMemberInvite(
      interaction.guild.id,
      kick.id,
      invite.code,
      status,
      deliveredToMember,
    );
    await updateBackupInteractionSession(interaction.guild.id, sessionId, {
      ...session.state,
      step: "complete",
    }).catch(() => undefined);
    const result =
      delivery === "admin"
        ? `Use this one-use invite after confirming it is appropriate: https://discord.gg/${invite.code}`
        : deliveredToMember
          ? "The invite was sent by DM."
          : `DM delivery failed. Use this one-use invite after confirming it is appropriate: https://discord.gg/${invite.code}`;
    await interaction.editReply({
      content:
        `${result}\n` +
        "No ban was removed. A currently banned member still needs a separate administrator decision.",
      embeds: [],
      components: [],
    });
  } catch (error) {
    await setKickedMemberRecoveryStatus(
      interaction.guild.id,
      kick.id,
      inviteCode ? "delivery_status_uncertain" : "invite_failed",
    ).catch(() => undefined);
    await updateBackupInteractionSession(interaction.guild.id, sessionId, {
      ...session.state,
      step: "complete",
    }).catch(() => undefined);
    await interaction.editReply({
      content: inviteCode
        ? `An invite was created, but its delivery status could not be fully saved. If needed, share it manually: https://discord.gg/${inviteCode}\nNo ban was removed.`
        : `Invite recovery failed: ${error instanceof Error ? error.message.slice(0, 220) : "unknown error"}`,
      embeds: [],
      components: [],
    });
  }
}

async function handleAutobackupToggle(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId || !isAdmin(interaction)) {
    await deny(interaction, "Only a server administrator can change backup settings.");
    return;
  }
  const setting = interaction.customId.split(":")[2];
  const current = await getBackupConfig(interaction.guildId);
  const now = new Date();
  const patch =
    setting === "auto"
      ? {
          autoBackupOn: !current.autoBackupOn,
          nextRunAt: current.autoBackupOn
            ? null
            : new Date(now.getTime() + current.intervalMinutes * 60_000),
        }
      : setting === "archive"
        ? { archiveOn: !current.archiveOn }
        : setting === "kicks"
          ? { kickTrackingOn: !current.kickTrackingOn }
          : null;
  if (!patch) {
    await deny(interaction, "That backup setting is not recognized.");
    return;
  }
  await setBackupConfig(interaction.guildId, {
    ...patch,
    updatedBy: interaction.user.id,
  });
  await interaction.update({
    content: await autobackupPanelText(interaction.guildId),
    components: autobackupComponents(await getBackupConfig(interaction.guildId, true)),
  });
}

async function handleBackupLoadConfirmation(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.guild || !isAdmin(interaction)) {
    await deny(interaction, "Only a server administrator can restore a backup.");
    return;
  }
  const [, , backupId, scope] = interaction.customId.split(":");
  if (!backupId || !scope) {
    await deny(interaction, "This restore confirmation is invalid.");
    return;
  }
  const restoreKey = `${interaction.guild.id}:${backupId}:${scope}`;
  if (activeManualRestores.has(restoreKey)) {
    await deny(interaction, "This restore confirmation is already being processed.");
    return;
  }
  activeManualRestores.add(restoreKey);
  try {
    const preview = await previewBackup(interaction.guild, backupId);
    if (!preview.ok) {
      await interaction.update({
        content: `Backup unavailable: ${preview.reason}`,
        components: [],
      });
      return;
    }
    const scopes =
      scope === "full"
        ? BACKUP_LOAD_SCOPES
        : scope === "structure"
          ? (["settings", "roles", "channels", "emojis"] as RestoreScope[])
          : [scope as RestoreScope];
    if (!scopes.every((value) => BACKUP_LOAD_SCOPES.includes(value))) {
      await deny(interaction, "The selected restore scope is invalid.");
      return;
    }
    await interaction.deferUpdate();
    const report = await restoreServerBackup(
      interaction.guild,
      backupId,
      new Set(scopes),
    );
    await interaction.editReply({
      content: `Recovery report\n${reportText(report)}`,
      embeds: [],
      components: [],
    });
  } finally {
    activeManualRestores.delete(restoreKey);
  }
}

async function handleRecoveryButton(
  interaction: ButtonInteraction,
  action: string,
  sessionId: string,
): Promise<void> {
  if (action === "cancel") {
    const session = await authorizedSession(interaction, sessionId);
    if (!session) return;
    await interaction.update({
      content: "Recovery cancelled. No restore actions were taken.",
      embeds: [],
      components: [],
    });
    return;
  }
  if (action === "preview") return showRestorePreview(interaction, sessionId);
  if (action === "confirm-backup") {
    return completeBackupRestore(interaction, sessionId);
  }
  if (action === "confirm-archive") {
    return completeArchiveRestore(interaction, sessionId);
  }
  if (action === "confirm-audit") {
    return completeAuditRecovery(interaction, sessionId);
  }
  if (action === "kick-dm") {
    return completeKickRecovery(interaction, sessionId, "dm");
  }
  if (action === "kick-admin") {
    return completeKickRecovery(interaction, sessionId, "admin");
  }
  await deny(interaction, "This recovery button is no longer supported.");
}

export async function handleBackupComponent(
  interaction: ComponentInteraction,
): Promise<boolean> {
  const { customId } = interaction;
  if (!isBackupComponent(customId)) return false;
  try {
    if (interaction.isButton()) {
      if (customId.startsWith("autobackup:toggle:")) {
        await handleAutobackupToggle(interaction);
      } else if (customId.startsWith("autobackup:")) {
        await deny(interaction, "This backup control is not recognized.");
      } else if (customId === "backup:cancel") {
        await interaction.update({
          content: "Restore cancelled. No changes were made.",
          embeds: [],
          components: [],
        });
      } else if (customId.startsWith("backup:confirm:")) {
        await handleBackupLoadConfirmation(interaction);
      } else if (customId.startsWith("backup:")) {
        await deny(interaction, "This backup action is not recognized.");
      } else if (customId.startsWith("gods:recover:")) {
        const [, , action, sessionId] = customId.split(":");
        if (action && sessionId) {
          await handleRecoveryButton(interaction, action, sessionId);
        } else {
          await deny(interaction, "This recovery button is invalid.");
        }
      }
      return true;
    }

    if (interaction.isStringSelectMenu() && customId.startsWith("gods:recover:")) {
      const [, , action, sessionId] = customId.split(":");
      if (!action || !sessionId) {
        await deny(interaction, "This recovery selection is invalid.");
        return true;
      }
      if (action === "target") {
        await handleTargetSelect(interaction, sessionId);
      } else if (action === "backup") {
        await handleBackupSelect(interaction, sessionId);
      } else if (action === "archive") {
        await handleArchiveSelect(interaction, sessionId);
      } else if (action === "audit") {
        await handleAuditSelect(interaction, sessionId);
      } else if (action === "scopes") {
        await handleScopeSelect(interaction, sessionId);
      } else if (action === "kick") {
        await handleKickSelect(interaction, sessionId);
      } else {
        await deny(interaction, "This recovery selection is no longer supported.");
      }
      return true;
    }
  } catch (error) {
    logger.warn(
      `[BACKUP] Recovery interaction failed: ${
        error instanceof Error ? error.message.slice(0, 240) : "unknown error"
      }`,
    );
    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply({
          content: "This recovery action failed safely. Review bot logs and try again.",
          embeds: [],
          components: [],
        })
        .catch(() => undefined);
    } else {
      await deny(interaction, "This recovery action failed safely. Try again.");
    }
    return true;
  }
  return true;
}
