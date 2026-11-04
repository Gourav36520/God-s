import {
  AttachmentBuilder,
  ChannelType,
  type APIEmbed,
  type Guild,
  type GuildBasedChannel,
  type GuildChannelCreateOptions,
  type Role,
} from "discord.js";
import {
  insertRestoredMemberRemovalEvent,
  insertRestoredKickedMemberRecovery,
  listArchivedMessageAssets,
  listArchivedMessages,
  listBackupAssets,
} from "@workspace/db";
import { verifyServerBackup } from "./backup-service.js";
import type {
  BackupChannel,
  BackupMessage,
  BackupResource,
  BackupSnapshot,
  RestoreReport,
} from "./types.js";

export type RestoreScope = Exclude<BackupResource, "kicked-members"> | "kicked-members";

export interface BackupPreview {
  snapshot: BackupSnapshot;
  missingChannels: number;
  missingRoles: number;
  unavailableAttachments: number;
}

type MessageRecoveryAsset = Pick<
  Awaited<ReturnType<typeof listBackupAssets>>[number],
  "resourceType" | "sourceId" | "partIndex" | "fileName" | "data"
>;

export function normalizeArchivedMessageAssets(
  assets: {
    messageId: string;
    partIndex: number;
    fileName: string;
    data: Buffer;
  }[],
): MessageRecoveryAsset[] {
  return assets.map((asset) => ({
    resourceType: "message_attachment",
    sourceId: asset.messageId,
    partIndex: asset.partIndex,
    fileName: asset.fileName,
    data: asset.data,
  }));
}

function makeReport(): RestoreReport {
  return { restored: [], skipped: [], failed: [], warnings: [] };
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 180) : "Discord request failed.";
}

function hasScope(scopes: ReadonlySet<RestoreScope>, scope: RestoreScope): boolean {
  return scopes.has(scope);
}

export async function previewBackup(
  guild: Guild,
  backupId: string,
): Promise<{ ok: true; preview: BackupPreview } | { ok: false; reason: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(backupId)) {
    return { ok: false, reason: "Backup ID format is invalid." };
  }
  const verified = await verifyServerBackup(guild.id, backupId);
  if (!verified.ok || !verified.snapshot) {
    return { ok: false, reason: verified.reason ?? "Backup could not be verified." };
  }
  const snapshot = verified.snapshot;
  const missingChannels = snapshot.channels.filter(
    (item) => !guild.channels.cache.has(item.id),
  ).length;
  const missingRoles = snapshot.roles.filter(
    (item) => item.id !== guild.id && !item.managed && !guild.roles.cache.has(item.id),
  ).length;
  const unavailableAttachments = snapshot.messages.reduce(
    (total, message) =>
      total + message.attachments.filter((attachment) => !attachment.archived).length,
    0,
  );
  return {
    ok: true,
    preview: { snapshot, missingChannels, missingRoles, unavailableAttachments },
  };
}

function rolePermissions(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function findExistingRole(guild: Guild, item: BackupSnapshot["roles"][number]): Role | null {
  const byId = guild.roles.cache.get(item.id);
  if (byId && !byId.managed) return byId;
  const matches = guild.roles.cache.filter(
    (role) => !role.managed && role.name === item.name && role.id !== guild.id,
  );
  return matches.size === 1 ? (matches.first() ?? null) : null;
}

async function restoreRoles(
  guild: Guild,
  snapshot: BackupSnapshot,
  roleIds: Map<string, string>,
  report: RestoreReport,
): Promise<void> {
  roleIds.set(guild.id, guild.id);
  for (const item of [...snapshot.roles].sort((a, b) => a.position - b.position)) {
    if (item.id === guild.id) {
      roleIds.set(item.id, guild.id);
      continue;
    }
    if (item.managed) {
      report.skipped.push(`Managed role "${item.name}" cannot be recreated by a bot.`);
      continue;
    }
    const permissions = rolePermissions(item.permissions);
    if (permissions === null) {
      report.failed.push(`Role "${item.name}" has invalid saved permissions.`);
      continue;
    }
    try {
      const existing = findExistingRole(guild, item);
      const role = existing
        ? await existing.edit({
            name: item.name,
            permissions,
            color: item.color,
            hoist: item.hoist,
            mentionable: item.mentionable,
            reason: "Administrator-confirmed God's Bot backup restore",
          })
        : await guild.roles.create({
            name: item.name,
            permissions,
            color: item.color,
            hoist: item.hoist,
            mentionable: item.mentionable,
            reason: "Administrator-confirmed God's Bot backup restore",
          });
      roleIds.set(item.id, role.id);
      if (!existing) await role.setPosition(item.position).catch(() => null);
      report.restored.push(`${existing ? "Updated" : "Created"} role "${item.name}".`);
    } catch (error) {
      report.failed.push(`Role "${item.name}": ${shortError(error)}`);
    }
  }
}

function mapOverwrites(
  item: BackupChannel,
  guild: Guild,
  roleIds: Map<string, string>,
  report: RestoreReport,
) {
  const mapped: {
    id: string;
    type: number;
    allow: string;
    deny: string;
  }[] = [];
  for (const overwrite of item.permissionOverwrites) {
    if (overwrite.type === 0) {
      const roleId = roleIds.get(overwrite.id) ?? guild.roles.cache.get(overwrite.id)?.id;
      if (!roleId) {
        report.warnings.push(
          `Skipped a missing role overwrite on channel "${item.name}".`,
        );
        continue;
      }
      mapped.push({ ...overwrite, id: roleId });
      continue;
    }
    if (overwrite.type === 1 && !guild.members.cache.has(overwrite.id)) {
      report.warnings.push(
        `Skipped an overwrite for a member no longer in the server on "${item.name}".`,
      );
      continue;
    }
    mapped.push(overwrite);
  }
  return mapped;
}

function existingChannel(
  guild: Guild,
  item: BackupChannel,
): GuildBasedChannel | null {
  const byId = guild.channels.cache.get(item.id);
  if (byId?.type === item.type) return byId;
  const matches = guild.channels.cache.filter(
    (channel) =>
      channel.type === item.type &&
      "name" in channel &&
      channel.name === item.name,
  );
  return matches.size === 1 ? (matches.first() ?? null) : null;
}

function channelOptions(
  item: BackupChannel,
  parentId: string | null,
  permissionOverwrites: ReturnType<typeof mapOverwrites>,
): GuildChannelCreateOptions {
  const base = {
    name: item.name,
    type: item.type,
    position: item.position,
    parent: parentId ?? undefined,
    permissionOverwrites,
    topic: item.topic ?? undefined,
    nsfw: item.nsfw,
    rateLimitPerUser: item.rateLimitPerUser ?? undefined,
    bitrate: item.bitrate ?? undefined,
    userLimit: item.userLimit ?? undefined,
    rtcRegion: item.rtcRegion ?? undefined,
    defaultAutoArchiveDuration:
      item.defaultAutoArchiveDuration ?? undefined,
  };
  return base as GuildChannelCreateOptions;
}

async function restoreChannels(
  guild: Guild,
  snapshot: BackupSnapshot,
  roleIds: Map<string, string>,
  channelIds: Map<string, string>,
  report: RestoreReport,
): Promise<void> {
  for (const item of snapshot.channels) {
    if (guild.channels.cache.has(item.id)) channelIds.set(item.id, item.id);
  }
  const ordered = [...snapshot.channels].sort((a, b) => {
    const categoryOrder =
      Number(a.type !== ChannelType.GuildCategory) -
      Number(b.type !== ChannelType.GuildCategory);
    return categoryOrder || a.position - b.position;
  });
  for (const item of ordered) {
    const parentId = item.parentId
      ? channelIds.get(item.parentId) ?? guild.channels.cache.get(item.parentId)?.id ?? null
      : null;
    if (item.parentId && !parentId) {
      report.warnings.push(`Category for channel "${item.name}" is unavailable.`);
    }
    const permissionOverwrites = mapOverwrites(item, guild, roleIds, report);
    const options = channelOptions(item, parentId, permissionOverwrites);
    try {
      const existing = existingChannel(guild, item);
      const editOptions = { ...options } as Record<string, unknown>;
      delete editOptions.type;
      const channel = existing
        ? await existing.edit(editOptions as never)
        : await guild.channels.create(options);
      channelIds.set(item.id, channel.id);
      report.restored.push(
        `${existing ? "Updated" : "Created"} channel "${item.name}".`,
      );
    } catch (error) {
      report.failed.push(`Channel "${item.name}": ${shortError(error)}`);
    }
  }
}

async function restoreSettings(
  guild: Guild,
  snapshot: BackupSnapshot,
  channelIds: Map<string, string>,
  report: RestoreReport,
): Promise<void> {
  const settings = snapshot.settings;
  try {
    const missingSettingsChannels = [
      settings.afkChannelId,
      settings.systemChannelId,
      settings.rulesChannelId,
      settings.publicUpdatesChannelId,
    ].filter((id) => id && !channelIds.has(id));
    if (missingSettingsChannels.length) {
      report.warnings.push(
        `${missingSettingsChannels.length} saved server setting channel reference(s) are unavailable and will be left unset.`,
      );
    }
    await guild.edit({
      name: settings.name,
      description: settings.description,
      verificationLevel: settings.verificationLevel,
      defaultMessageNotifications: settings.defaultMessageNotifications,
      explicitContentFilter: settings.explicitContentFilter,
      afkTimeout: settings.afkTimeout,
      afkChannel: settings.afkChannelId
        ? channelIds.get(settings.afkChannelId) ?? null
        : null,
      systemChannel: settings.systemChannelId
        ? channelIds.get(settings.systemChannelId) ?? null
        : null,
      rulesChannel: settings.rulesChannelId
        ? channelIds.get(settings.rulesChannelId) ?? null
        : null,
      publicUpdatesChannel: settings.publicUpdatesChannelId
        ? channelIds.get(settings.publicUpdatesChannelId) ?? null
        : null,
      preferredLocale: settings.preferredLocale,
      premiumProgressBarEnabled: settings.premiumProgressBarEnabled,
      systemChannelFlags: settings.systemChannelFlags,
      reason: "Administrator-confirmed God's Bot backup restore",
    } as never);
    report.restored.push("Applied supported server settings.");
  } catch (error) {
    report.failed.push(`Server settings: ${shortError(error)}`);
  }
}

async function repostMessage(
  channel: GuildBasedChannel,
  item: BackupMessage,
  assets: readonly MessageRecoveryAsset[],
  report: RestoreReport,
): Promise<void> {
  if (!channel.isTextBased() || !("send" in channel)) {
    report.skipped.push(`Messages for "${item.channelName}" have no supported text channel.`);
    return;
  }
  const files = assets
    .filter(
      (asset) =>
        asset.resourceType === "message_attachment" &&
        asset.sourceId === item.id,
    )
    .map(
      (asset) =>
        new AttachmentBuilder(asset.data, { name: asset.fileName }),
    );
  for (const [index, attachment] of item.attachments.entries()) {
    if (
      attachment.archived &&
      !assets.some(
        (asset) =>
          asset.resourceType === "message_attachment" &&
          asset.sourceId === item.id &&
          asset.partIndex === index,
      )
    ) {
      report.skipped.push(
        `Stored file "${attachment.fileName}" for message ${item.id} is missing.`,
      );
    }
  }
  const author = item.authorUsername
    ? `${item.authorUsername}${item.authorId ? ` (${item.authorId})` : ""}`
    : item.authorId ?? "Unknown author";
  const originalTime = item.createdAt ?? "not available";
  const header = [
    item.deletedAt ? "**Recovered deleted message**" : "**Recovered message**",
    `Original author: ${author}`,
    `Original time: ${originalTime}`,
    `Original message ID (not recreated): ${item.id}`,
    item.editedAt ? `Last observed edit: ${item.editedAt}` : "",
    item.deletedAt ? `Deletion observed: ${item.deletedAt}` : "",
    item.replyToMessageId
      ? `Original reply reference (not recreated): ${item.replyToMessageId}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const originalContent = item.content || (item.embeds.length ? "" : "[No content was archived.]");
  const firstRoom = Math.max(0, 2000 - header.length - 1);
  const firstContent = originalContent.slice(0, firstRoom);
  let remainingContent = originalContent.slice(firstRoom);
  const firstMessage = `${header}${firstContent ? `\n${firstContent}` : ""}`;
  await channel.send({
    content: firstMessage.slice(0, 2000),
    embeds: item.embeds as APIEmbed[],
    files,
    allowedMentions: { parse: [] },
  });
  while (remainingContent) {
    const chunk = remainingContent.slice(0, 1900);
    remainingContent = remainingContent.slice(chunk.length);
    await channel.send({
      content: `Recovered message continuation\n${chunk}`,
      allowedMentions: { parse: [] },
    });
  }
  for (const version of item.editHistory) {
    const label = `Recovered previous version${version.editedAt ? ` from ${version.editedAt}` : ""}`;
    const content = `${label}\n${version.content}`;
    for (let offset = 0; offset < content.length; offset += 1900) {
      await channel.send({
        content: content.slice(offset, offset + 1900),
        allowedMentions: { parse: [] },
      });
    }
  }
  report.restored.push(`Reposted message ${item.id} in #${item.channelName}.`);
}

async function restoreMessages(
  guild: Guild,
  snapshot: BackupSnapshot,
  channelIds: Map<string, string>,
  assets: readonly MessageRecoveryAsset[],
  report: RestoreReport,
): Promise<void> {
  for (const item of snapshot.messages) {
    const mappedId = channelIds.get(item.channelId) ?? item.channelId;
    const channel = guild.channels.cache.get(mappedId);
    if (!channel) {
      report.skipped.push(
        `Message ${item.id} skipped because channel "${item.channelName}" is missing.`,
      );
      continue;
    }
    try {
      await repostMessage(channel, item, assets, report);
    } catch (error) {
      report.failed.push(`Message ${item.id}: ${shortError(error)}`);
    }
  }
}

async function restoreEmojis(
  guild: Guild,
  snapshot: BackupSnapshot,
  roleIds: Map<string, string>,
  assets: Awaited<ReturnType<typeof listBackupAssets>>,
  report: RestoreReport,
): Promise<void> {
  for (const emoji of snapshot.emojis) {
    const existing = guild.emojis.cache.find((item) => item.name === emoji.name);
    if (existing) {
      report.skipped.push(`Emoji "${emoji.name}" already exists.`);
      continue;
    }
    const asset = assets.find(
      (item) => item.resourceType === "emoji" && item.sourceId === emoji.id,
    );
    if (!asset) {
      report.skipped.push(`Emoji "${emoji.name}" has no stored image file.`);
      continue;
    }
    const roles = emoji.roles
      .map((roleId) => roleIds.get(roleId) ?? guild.roles.cache.get(roleId)?.id)
      .filter((roleId): roleId is string => Boolean(roleId));
    try {
      await guild.emojis.create({
        attachment: asset.data,
        name: emoji.name,
        roles,
        reason: "Administrator-confirmed God's Bot backup restore",
      });
      report.restored.push(`Created emoji "${emoji.name}".`);
    } catch (error) {
      report.failed.push(`Emoji "${emoji.name}": ${shortError(error)}`);
    }
  }
}

async function restoreKickedMembers(
  guild: Guild,
  snapshot: BackupSnapshot,
  report: RestoreReport,
): Promise<void> {
  for (const kick of snapshot.kickedMembers) {
    try {
      await insertRestoredKickedMemberRecovery({
        guildId: guild.id,
        memberId: kick.memberId,
        username: kick.username,
        kickedAt: new Date(kick.kickedAt),
        executorId: kick.executorId,
        evidence: kick.evidence,
        deliveryStatus: kick.deliveryStatus,
        rejoinedAt: kick.rejoinedAt ? new Date(kick.rejoinedAt) : null,
      });
      report.restored.push(`Restored kick-recovery record for ${kick.username}.`);
    } catch (error) {
      report.failed.push(`Kick record for ${kick.username}: ${shortError(error)}`);
    }
  }
  for (const event of snapshot.memberRemovals ?? []) {
    try {
      await insertRestoredMemberRemovalEvent({
        guildId: guild.id,
        memberId: event.memberId,
        username: event.username,
        removedAt: new Date(event.removedAt),
        classification: event.classification,
        executorId: event.executorId,
        evidence: event.evidence,
      });
      report.restored.push(
        `Restored ${event.classification} removal evidence for ${event.username}.`,
      );
    } catch (error) {
      report.failed.push(
        `Removal evidence for ${event.username}: ${shortError(error)}`,
      );
    }
  }
}

export async function restoreServerBackup(
  guild: Guild,
  backupId: string,
  scopes: ReadonlySet<RestoreScope>,
): Promise<RestoreReport> {
  const report = makeReport();
  const preview = await previewBackup(guild, backupId);
  if (!preview.ok) {
    report.failed.push(preview.reason);
    return report;
  }
  const { snapshot } = preview.preview;
  const roleIds = new Map<string, string>();
  const channelIds = new Map<string, string>();
  const assets = await listBackupAssets(guild.id, backupId);

  if (hasScope(scopes, "roles")) {
    await restoreRoles(guild, snapshot, roleIds, report);
  } else {
    roleIds.set(guild.id, guild.id);
    for (const role of snapshot.roles) {
      if (guild.roles.cache.has(role.id)) roleIds.set(role.id, role.id);
    }
  }
  if (hasScope(scopes, "channels")) {
    await restoreChannels(guild, snapshot, roleIds, channelIds, report);
  } else {
    for (const channel of snapshot.channels) {
      if (guild.channels.cache.has(channel.id)) channelIds.set(channel.id, channel.id);
    }
  }
  if (hasScope(scopes, "settings")) {
    await restoreSettings(guild, snapshot, channelIds, report);
  }
  if (hasScope(scopes, "emojis")) {
    await restoreEmojis(guild, snapshot, roleIds, assets, report);
  }
  if (hasScope(scopes, "messages")) {
    await restoreMessages(guild, snapshot, channelIds, assets, report);
  }
  if (hasScope(scopes, "kicked-members")) {
    await restoreKickedMembers(guild, snapshot, report);
  }
  if (snapshot.warnings.length) report.warnings.push(...snapshot.warnings);
  report.warnings.push(
    "Discord assigns new IDs and current timestamps to restored content; archived originals are metadata only.",
  );
  return report;
}

export async function restoreArchivedChannelMessages(
  guild: Guild,
  channelId: string,
): Promise<RestoreReport> {
  const report = makeReport();
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    report.failed.push("The original channel is not available in this server.");
    return report;
  }
  const messages = await listArchivedMessages(guild.id, channelId);
  for (const row of messages) {
    const assets = await listArchivedMessageAssets(
      guild.id,
      channelId,
      row.messageId,
    );
    const item: BackupMessage = {
      id: row.messageId,
      channelId: row.channelId,
      channelName: row.channelName,
      channelType: row.channelType,
      parentId: row.parentId,
      parentName: row.parentName,
      authorId: row.authorId,
      authorUsername: row.authorUsername,
      content: row.content,
      createdAt: row.createdAt?.toISOString() ?? null,
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      replyToMessageId: row.replyToMessageId,
      embeds: row.embeds,
      attachments: row.attachments as unknown as BackupMessage["attachments"],
      editHistory: row.editHistory,
    };
    try {
      await repostMessage(channel, item, normalizeArchivedMessageAssets(assets), report);
    } catch (error) {
      report.failed.push(`Message ${row.messageId}: ${shortError(error)}`);
    }
  }
  report.warnings.push(
    "Original message IDs, timestamps, and reply links cannot be recreated.",
  );
  return report;
}
