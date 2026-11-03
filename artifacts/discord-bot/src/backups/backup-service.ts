import { createHash, randomUUID } from "node:crypto";
import {
  ChannelType,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Guild,
  type Message,
  type Role,
} from "discord.js";
import {
  completeBackupRecord,
  deleteBackupAssets,
  ensureAutobackupConfig,
  failBackupRecord,
  getBackupRecord,
  getBackupStorageStatus,
  getArchivedMessage,
  listBackupAssets,
  listBackupRecords,
  insertBackupAssets,
  insertBackupRecord,
  listAllArchivedMessageAssets,
  listArchivedMessages,
  listKickedMemberRecoveries,
  listMemberRemovalEvents,
  pruneBackups,
  updateAutobackupConfig,
  upsertArchivedMessage,
} from "@workspace/db";
import type {
  BackupAssetInput,
  BackupAttachment,
  BackupChannel,
  BackupEmoji,
  BackupGuildSettings,
  BackupMessage,
  BackupRole,
  BackupSnapshot,
  BackupSummary,
} from "./types.js";
import { BACKUP_FORMAT_VERSION } from "./types.js";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_BACKUP_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_GUILD_STORAGE_BYTES = 512 * 1024 * 1024;
const CONFIG_CACHE_MS = 15_000;
const STORAGE_CACHE_MS = 30_000;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const configCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof ensureAutobackupConfig>>>>();
const storageCache = new Map<string, CacheEntry<number>>();

export interface BackupBuildResult {
  backupId: string;
  checksum: string;
  summary: BackupSummary;
}

export interface AttachmentCapture {
  metadata: BackupAttachment;
  asset: Omit<BackupAssetInput, "backupId"> | null;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function backupChecksum(
  snapshot: BackupSnapshot,
  assets: Array<{
    resourceType: string;
    sourceId: string;
    partIndex: number;
    fileName: string;
    byteSize: number;
    checksum: string;
  }>,
): string {
  const hash = createHash("sha256");
  hash.update(stableJson(snapshot));
  for (const asset of [...assets].sort((a, b) =>
    `${a.resourceType}:${a.sourceId}:${a.partIndex}`.localeCompare(
      `${b.resourceType}:${b.sourceId}:${b.partIndex}`,
    ),
  )) {
    hash.update(
      `\n${asset.resourceType}:${asset.sourceId}:${asset.partIndex}:${asset.fileName}:${asset.byteSize}:${asset.checksum}`,
    );
  }
  return hash.digest("hex");
}

function safeFileName(name: string): string {
  return name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "").slice(0, 180) || "attachment.bin";
}

function isDiscordCdnUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      (url.hostname === "cdn.discordapp.com" ||
        url.hostname === "media.discordapp.net") &&
      /^\/(?:attachments|emojis)\//.test(url.pathname)
    );
  } catch {
    return false;
  }
}

async function downloadDiscordFile(
  url: string,
  fileName: string,
  contentType: string,
  advertisedBytes: number,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!isDiscordCdnUrl(url) || advertisedBytes > maxBytes || advertisedBytes <= 0) {
    return null;
  }
  const response = await fetch(url, { redirect: "error" }).catch(() => null);
  if (!response?.ok) return null;
  const headerSize = Number(response.headers.get("content-length") ?? 0);
  if (headerSize > maxBytes) return null;
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > maxBytes) return null;
  void fileName;
  void contentType;
  return data;
}

export async function getBackupConfig(
  guildId: string,
  forceRefresh = false,
): Promise<Awaited<ReturnType<typeof ensureAutobackupConfig>>> {
  const now = Date.now();
  const cached = configCache.get(guildId);
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.value;
  const config = await ensureAutobackupConfig(guildId);
  configCache.set(guildId, { value: config, expiresAt: now + CONFIG_CACHE_MS });
  return config;
}

export async function setBackupConfig(
  guildId: string,
  patch: Parameters<typeof updateAutobackupConfig>[1],
): Promise<Awaited<ReturnType<typeof updateAutobackupConfig>>> {
  const config = await updateAutobackupConfig(guildId, patch);
  configCache.set(guildId, { value: config, expiresAt: Date.now() + CONFIG_CACHE_MS });
  return config;
}

async function getStorageBytes(guildId: string): Promise<number> {
  const now = Date.now();
  const cached = storageCache.get(guildId);
  if (cached && cached.expiresAt > now) return cached.value;
  const status = await getBackupStorageStatus(guildId);
  storageCache.set(guildId, {
    value: status.bytes,
    expiresAt: now + STORAGE_CACHE_MS,
  });
  return status.bytes;
}

function toBackupMessage(
  source: {
    id: string;
    channelId: string;
    channelName: string;
    channelType: string;
    parentId: string | null;
    parentName: string | null;
    authorId: string | null;
    authorUsername: string | null;
    content: string;
    createdAt: Date | null;
    editedAt: Date | null;
    deletedAt: Date | null;
    replyToMessageId: string | null;
    embeds: Record<string, unknown>[];
    attachments: Record<string, unknown>[];
    editHistory?: { content: string; editedAt: string | null }[];
  },
): BackupMessage {
  return {
    id: source.id,
    channelId: source.channelId,
    channelName: source.channelName,
    channelType: source.channelType,
    parentId: source.parentId,
    parentName: source.parentName,
    authorId: source.authorId,
    authorUsername: source.authorUsername,
    content: source.content,
    createdAt: source.createdAt?.toISOString() ?? null,
    editedAt: source.editedAt?.toISOString() ?? null,
    deletedAt: source.deletedAt?.toISOString() ?? null,
    replyToMessageId: source.replyToMessageId,
    embeds: source.embeds,
    attachments: source.attachments as unknown as BackupAttachment[],
    editHistory: source.editHistory ?? [],
  };
}

function messageChannelInfo(message: Message) {
  const channel = message.channel;
  return {
    channelName:
      ("name" in channel ? channel.name : null) || channel.id,
    channelType: String(channel.type),
    parentId: "parentId" in channel ? channel.parentId : null,
      parentName:
      "parent" in channel && channel.parent && "name" in channel.parent
        ? channel.parent.name
        : null,
  };
}

async function captureMessageAttachments(
  message: Message,
  guildId: string,
  maxBytes: number,
  resourceType: "message_attachment",
): Promise<{ metadata: BackupAttachment[]; assets: Omit<BackupAssetInput, "backupId">[] }> {
  const metadata: BackupAttachment[] = [];
  const assets: Omit<BackupAssetInput, "backupId">[] = [];
  let usedBytes = 0;
  for (const [index, attachment] of [...message.attachments.values()].entries()) {
    const fileName = safeFileName(attachment.name);
    const contentType = attachment.contentType ?? "application/octet-stream";
    const remaining = Math.max(0, maxBytes - usedBytes);
    const data =
      attachment.size <= MAX_ATTACHMENT_BYTES && attachment.size <= remaining
        ? await downloadDiscordFile(
            attachment.url,
            fileName,
            contentType,
            attachment.size,
            Math.min(MAX_ATTACHMENT_BYTES, remaining),
          )
        : null;
    if (!data) {
      metadata.push({
        fileName,
        contentType,
        byteSize: attachment.size,
        archived: false,
        unavailableReason:
          attachment.size > MAX_ATTACHMENT_BYTES
            ? "File exceeds the per-file storage limit."
            : remaining <= 0 || attachment.size > remaining
              ? "Storage limit reached."
              : "Discord attachment was unavailable for download.",
      });
      continue;
    }
    usedBytes += data.length;
    metadata.push({
      fileName,
      contentType,
      byteSize: data.length,
      archived: true,
    });
    assets.push({
      guildId,
      resourceType,
      sourceId: message.id,
      partIndex: index,
      fileName,
      contentType,
      byteSize: data.length,
      checksum: sha256(data),
      data,
    });
  }
  return { metadata, assets };
}

export async function archiveDiscordMessage(
  message: Message,
  options: { deleted?: boolean } = {},
): Promise<void> {
  if (!message.guildId || !message.guild || message.guildId !== message.guild.id) return;
  const config = await getBackupConfig(message.guildId).catch(() => null);
  if (!config?.archiveOn) return;
  const channel = message.channel;
  if (
    !channel.isTextBased() ||
    !("messages" in channel) ||
    message.author?.bot
  ) {
    return;
  }

  const guildBytes = await getStorageBytes(message.guildId).catch(() => MAX_GUILD_STORAGE_BYTES);
  const storageAllowance = Math.max(0, MAX_GUILD_STORAGE_BYTES - guildBytes);
  const archiveAllowance = Math.min(MAX_ARCHIVE_ATTACHMENT_BYTES, storageAllowance);
  const attachments = await captureMessageAttachments(
    message,
    message.guildId,
    archiveAllowance,
    "message_attachment",
  );
  const info = messageChannelInfo(message);
  const prior = await getArchivedMessage(message.guildId, channel.id, message.id);
  const history = prior?.editHistory ?? [];
  if (prior && prior.content !== message.content && message.editedAt) {
    history.push({
      content: prior.content,
      editedAt: prior.editedAt?.toISOString() ?? prior.createdAt?.toISOString() ?? null,
    });
  }
  const value = {
    guildId: message.guildId,
    channelId: channel.id,
    channelName: info.channelName,
    channelType: info.channelType,
    parentId: info.parentId,
    parentName: info.parentName,
    messageId: message.id,
    authorId: message.author?.id ?? null,
    authorUsername: message.author?.username ?? null,
    content: message.content ?? "",
    createdAt: message.createdAt ?? null,
    editedAt: message.editedAt ?? null,
    deletedAt: options.deleted ? new Date() : null,
    replyToMessageId: message.reference?.messageId ?? null,
    embeds: message.embeds.map((embed) => embed.toJSON() as Record<string, unknown>),
    attachments: attachments.metadata as unknown as Record<string, unknown>[],
    editHistory: history.slice(-10),
  };
  await upsertArchivedMessage(
    value,
    attachments.assets.map((asset) => ({
      ...asset,
      channelId: channel.id,
      messageId: message.id,
    })),
  );
  storageCache.delete(message.guildId);
}

export async function archiveDeletedMessage(
  message: Message,
): Promise<void> {
  await archiveDiscordMessage(message, { deleted: true });
}

function snapshotSettings(guild: Guild): BackupGuildSettings {
  return {
    name: guild.name,
    description: guild.description ?? null,
    verificationLevel: guild.verificationLevel,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    explicitContentFilter: guild.explicitContentFilter,
    afkTimeout: guild.afkTimeout,
    afkChannelId: guild.afkChannelId,
    systemChannelId: guild.systemChannelId,
    rulesChannelId: guild.rulesChannelId,
    publicUpdatesChannelId: guild.publicUpdatesChannelId,
    preferredLocale: guild.preferredLocale,
    premiumProgressBarEnabled: guild.premiumProgressBarEnabled,
    systemChannelFlags: Number(guild.systemChannelFlags.bitfield),
  };
}

function snapshotRole(role: Role): BackupRole {
  return {
    id: role.id,
    name: role.name,
    permissions: role.permissions.bitfield.toString(),
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    position: role.position,
    managed: role.managed,
  };
}

function snapshotChannel(channel: any): BackupChannel {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    position: channel.position,
    parentId: channel.parentId ?? null,
    topic: channel.topic ?? null,
    nsfw: Boolean(channel.nsfw),
    rateLimitPerUser: channel.rateLimitPerUser ?? null,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,
    rtcRegion: channel.rtcRegion ?? null,
    defaultAutoArchiveDuration: channel.defaultAutoArchiveDuration ?? null,
    permissionOverwrites: channel.permissionOverwrites.cache.map((overwrite: any) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield.toString(),
      deny: overwrite.deny.bitfield.toString(),
    })),
  };
}

async function snapshotDiscordMessage(
  message: Message,
  guildId: string,
  backupId: string,
  remainingBytes: number,
): Promise<{ message: BackupMessage; assets: BackupAssetInput[] }> {
  const info = messageChannelInfo(message);
  const attachments = await captureMessageAttachments(
    message,
    guildId,
    remainingBytes,
    "message_attachment",
  );
  return {
    message: {
      id: message.id,
      channelId: message.channelId,
      ...info,
      authorId: message.author.id,
      authorUsername: message.author.username,
      content: message.content ?? "",
      createdAt: message.createdAt?.toISOString() ?? null,
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: null,
      replyToMessageId: message.reference?.messageId ?? null,
      embeds: message.embeds.map((embed) => embed.toJSON() as Record<string, unknown>),
      attachments: attachments.metadata,
      editHistory: [],
    },
    assets: attachments.assets.map((asset) => ({ ...asset, backupId })),
  };
}

function archiveAssetKey(channelId: string, messageId: string, partIndex: number): string {
  return `${channelId}:${messageId}:${partIndex}`;
}

function backupAssetIdentity(asset: Pick<BackupAssetInput, "resourceType" | "sourceId" | "partIndex">): string {
  return `${asset.resourceType}:${asset.sourceId}:${asset.partIndex}`;
}

export async function createServerBackup(
  guild: Guild,
  createdBy: string,
  source: "manual" | "automatic" | "recovery",
  onProgress?: (message: string) => Promise<void> | void,
): Promise<BackupBuildResult> {
  const backupId = randomUUID();
  await insertBackupRecord({ id: backupId, guildId: guild.id, createdBy, source });
  const warnings: string[] = [];
  const assets: BackupAssetInput[] = [];
  let attachmentBytes = 0;

  try {
    const config = await getBackupConfig(guild.id);
    const roles = [...guild.roles.cache.values()]
      .sort((left, right) => left.position - right.position)
      .map((role) => snapshotRole(role));
    const supportedChannelTypes = new Set<number>([
      ChannelType.GuildCategory,
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildVoice,
      ChannelType.GuildStageVoice,
      ChannelType.GuildForum,
    ]);
    const allGuildChannels = [...guild.channels.cache.values()];
    const supportedChannels = allGuildChannels.filter((channel) =>
      supportedChannelTypes.has(channel.type),
    );
    const unsupportedCount = allGuildChannels.length - supportedChannels.length;
    if (unsupportedCount > 0) {
      warnings.push(`${unsupportedCount} unsupported channel(s) were omitted.`);
    }
    const channels = supportedChannels
      .map((channel) => snapshotChannel(channel))
      .sort((left, right) => left.position - right.position);

    const archivedRows = await listArchivedMessages(guild.id);
    const archivedAssetRows = await listAllArchivedMessageAssets(guild.id);
    const archiveByChannel = new Map<string, typeof archivedRows>();
    for (const row of archivedRows) {
      const list = archiveByChannel.get(row.channelId) ?? [];
      list.push(row);
      archiveByChannel.set(row.channelId, list);
    }
    const archivedAssetMap = new Map<string, typeof archivedAssetRows>();
    for (const asset of archivedAssetRows) {
      const key = archiveAssetKey(asset.channelId, asset.messageId, asset.partIndex);
      const list = archivedAssetMap.get(key) ?? [];
      list.push(asset);
      archivedAssetMap.set(key, list);
    }

    const messages: BackupMessage[] = [];
    if (
      !guild.client.options.intents.has(GatewayIntentBits.MessageContent)
    ) {
      warnings.push(
        "Message Content intent is not active; Discord may return empty message content.",
      );
    }
    const currentStorageBytes = await getStorageBytes(guild.id);
    const backupAttachmentLimit = Math.min(
      MAX_BACKUP_ATTACHMENT_BYTES,
      Math.max(0, MAX_GUILD_STORAGE_BYTES - currentStorageBytes),
    );
    if (backupAttachmentLimit === 0) {
      warnings.push("Attachment storage limit reached; backup will contain message metadata without new files.");
    }
    const supportedTextChannels = [...guild.channels.cache.values()].filter(
      (channel) =>
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildAnnouncement,
    );
    let visitedChannels = 0;
    for (const channel of supportedTextChannels) {
      visitedChannels++;
      if (visitedChannels % 10 === 0) {
        await onProgress?.(`Captured message history from ${visitedChannels}/${supportedTextChannels.length} text channels.`);
      }
      const fetched = new Map<string, Message>();
      if (channel.isTextBased() && "messages" in channel) {
        const recent = await channel.messages.fetch({ limit: 100 }).catch((error: unknown) => {
          warnings.push(
            `Could not read ${channel.name}: ${error instanceof Error ? error.message.slice(0, 120) : "missing history permission"}`,
          );
          return null;
        });
        for (const message of recent?.values() ?? []) fetched.set(message.id, message);
      }

      const archived = archiveByChannel.get(channel.id) ?? [];
      const sourceIds = new Set([...fetched.keys(), ...archived.map((row) => row.messageId)]);
      const chosen = [...sourceIds]
        .map((id) => ({
          id,
          live: fetched.get(id),
          archived: archived.find((row) => row.messageId === id),
        }))
        .sort((left, right) => {
          const leftDate = left.live?.createdAt.getTime() ??
            left.archived?.createdAt?.getTime() ??
            left.archived?.observedAt.getTime() ??
            0;
          const rightDate = right.live?.createdAt.getTime() ??
            right.archived?.createdAt?.getTime() ??
            right.archived?.observedAt.getTime() ??
            0;
          return leftDate - rightDate;
        })
        .slice(-100);

      for (const item of chosen) {
        if (item.live) {
          const captured = await snapshotDiscordMessage(
            item.live,
            guild.id,
            backupId,
            Math.max(0, backupAttachmentLimit - attachmentBytes),
          );
          messages.push(captured.message);
          assets.push(...captured.assets);
          attachmentBytes += captured.assets.reduce((sum, asset) => sum + asset.byteSize, 0);
          const prior = item.archived;
          if (prior) {
            const existingHistory = prior.editHistory ?? [];
            const current = captured.message.content;
            if (prior.content !== current && !existingHistory.some((edit) => edit.content === prior.content)) {
              captured.message.editHistory = [
                ...existingHistory,
                { content: prior.content, editedAt: prior.editedAt?.toISOString() ?? null },
              ].slice(-10);
            } else {
              captured.message.editHistory = existingHistory.slice(-10);
            }
          }
          continue;
        }
        if (!item.archived) continue;

        const archivedMessage = toBackupMessage({
          id: item.archived.messageId,
          channelId: item.archived.channelId,
          channelName: item.archived.channelName,
          channelType: item.archived.channelType,
          parentId: item.archived.parentId,
          parentName: item.archived.parentName,
          authorId: item.archived.authorId,
          authorUsername: item.archived.authorUsername,
          content: item.archived.content,
          createdAt: item.archived.createdAt,
          editedAt: item.archived.editedAt,
          deletedAt: item.archived.deletedAt,
          replyToMessageId: item.archived.replyToMessageId,
          embeds: item.archived.embeds,
          attachments: item.archived.attachments,
          editHistory: item.archived.editHistory,
        });
        messages.push(archivedMessage);
        for (const [index, attachment] of (
          item.archived.attachments as unknown as BackupAttachment[]
        ).entries()) {
          if (!attachment.archived) continue;
          const storedRows = archivedAssetMap.get(
            archiveAssetKey(item.archived.channelId, item.archived.messageId, index),
          ) ?? [];
          const archivedAsset = storedRows[0];
          if (!archivedAsset) {
            attachment.archived = false;
            attachment.unavailableReason = "Archived attachment data is missing.";
            warnings.push(`Attachment ${attachment.fileName} for message ${item.archived.messageId} is missing from archive storage.`);
            continue;
          }
          if (attachmentBytes + archivedAsset.byteSize > backupAttachmentLimit) {
            attachment.archived = false;
            attachment.unavailableReason = "Backup attachment storage limit reached.";
            continue;
          }
          assets.push({
            guildId: guild.id,
            backupId,
            resourceType: "message_attachment",
            sourceId: item.archived.messageId,
            partIndex: index,
            fileName: archivedAsset.fileName,
            contentType: archivedAsset.contentType,
            byteSize: archivedAsset.byteSize,
            checksum: archivedAsset.checksum,
            data: archivedAsset.data,
          });
          attachmentBytes += archivedAsset.byteSize;
        }
      }
    }

    const emojis: BackupEmoji[] = [];
    for (const emoji of guild.emojis.cache.values()) {
      const emojiRecord: BackupEmoji = {
        id: emoji.id ?? emoji.name ?? "unknown",
        name: emoji.name ?? "emoji",
        animated: emoji.animated,
        roles: [...emoji.roles.cache.keys()],
        assetArchived: false,
      };
      if (emoji.id) {
        const imageUrl = emoji.imageURL({
          extension: emoji.animated ? "gif" : "png",
          size: 1024,
        });
        const available = Math.max(0, backupAttachmentLimit - attachmentBytes);
        const data =
          available > 0
            ? await downloadDiscordFile(
                imageUrl,
                `${emojiRecord.name}.${emoji.animated ? "gif" : "png"}`,
                emoji.animated ? "image/gif" : "image/png",
                Math.min(available, MAX_ATTACHMENT_BYTES),
                Math.min(available, MAX_ATTACHMENT_BYTES),
              )
            : null;
        if (data) {
          const fileName = safeFileName(`${emojiRecord.name}.${emoji.animated ? "gif" : "png"}`);
          const contentType = emoji.animated ? "image/gif" : "image/png";
          assets.push({
            guildId: guild.id,
            backupId,
            resourceType: "emoji",
            sourceId: emoji.id,
            partIndex: 0,
            fileName,
            contentType,
            byteSize: data.length,
            checksum: sha256(data),
            data,
          });
          attachmentBytes += data.length;
          emojiRecord.assetArchived = true;
        } else {
          warnings.push(`Emoji ${emoji.name ?? emoji.id} image could not be stored.`);
        }
      }
      emojis.push(emojiRecord);
    }

    const kicks = await listKickedMemberRecoveries(guild.id, 1000);
    const kickedMembers = kicks.map((kick) => ({
      memberId: kick.memberId,
      username: kick.username,
      kickedAt: kick.kickedAt.toISOString(),
      executorId: kick.executorId,
      evidence: kick.evidence,
      deliveryStatus: kick.deliveryStatus,
      rejoinedAt: kick.rejoinedAt?.toISOString() ?? null,
    }));
    const removalRows = await listMemberRemovalEvents(guild.id, 1000);
    const memberRemovals = removalRows.map((event) => ({
      memberId: event.memberId,
      username: event.username,
      removedAt: event.removedAt.toISOString(),
      classification: event.classification as
        | "kick"
        | "ban"
        | "leave"
        | "unknown",
      executorId: event.executorId,
      evidence: event.evidence,
    }));

    const snapshot: BackupSnapshot = {
      formatVersion: BACKUP_FORMAT_VERSION,
      guildId: guild.id,
      createdAt: new Date().toISOString(),
      settings: snapshotSettings(guild),
      roles,
      channels,
      emojis,
      messages,
      kickedMembers,
      memberRemovals,
      warnings,
    };
    const summary: BackupSummary = {
      roles: roles.length,
      channels: channels.length,
      emojis: emojis.length,
      messages: messages.length,
      attachments: assets.filter((asset) => asset.resourceType === "message_attachment").length,
      kickedMembers: kickedMembers.length,
      memberRemovals: memberRemovals.length,
      unavailableAttachments: messages.reduce(
        (count, message) => count + message.attachments.filter((attachment) => !attachment.archived).length,
        0,
      ),
      warnings,
    };

    await insertBackupAssets(assets);
    const checksum = backupChecksum(snapshot, assets);
    await completeBackupRecord(backupId, guild.id, {
      snapshot: snapshot as unknown as Record<string, unknown>,
      checksum,
      warningCount: warnings.length,
      summary: summary as unknown as Record<string, unknown>,
    });
    const verified = await verifyServerBackup(guild.id, backupId);
    if (!verified.ok) {
      await failBackupRecord(backupId, guild.id, `Integrity verification failed: ${verified.reason}`);
      throw new Error(`Backup integrity verification failed: ${verified.reason}`);
    }

    if (config.retentionCount > 0) {
      await pruneBackups(guild.id, config.retentionCount);
    }
    storageCache.delete(guild.id);
    return { backupId, checksum, summary };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown backup error.";
    await failBackupRecord(backupId, guild.id, reason).catch(() => undefined);
    await deleteBackupAssets(guild.id, backupId).catch(() => undefined);
    storageCache.delete(guild.id);
    throw error;
  }
}

export async function verifyServerBackup(
  guildId: string,
  backupId: string,
): Promise<{ ok: boolean; reason?: string; snapshot?: BackupSnapshot }> {
  const record = await getBackupRecord(guildId, backupId);
  if (!record?.snapshot || !record.checksum) {
    return { ok: false, reason: "Backup is missing or incomplete." };
  }
  const snapshot = record.snapshot as unknown as BackupSnapshot;
  if (
    snapshot.formatVersion !== BACKUP_FORMAT_VERSION ||
    snapshot.guildId !== guildId
  ) {
    return { ok: false, reason: "Backup format or guild identity is invalid." };
  }
  const assets = await listBackupAssets(guildId, backupId);
  for (const asset of assets) {
    if (asset.data.length !== asset.byteSize || sha256(asset.data) !== asset.checksum) {
      return { ok: false, reason: `Stored file ${asset.fileName} failed its checksum.` };
    }
  }
  const actual = backupChecksum(snapshot, assets);
  if (actual !== record.checksum) {
    return { ok: false, reason: "Backup manifest checksum does not match." };
  }
  return { ok: true, snapshot };
}

export async function listGuildBackups(guildId: string, page = 0) {
  return listBackupRecords(guildId, 25, page * 25);
}

export async function loadVerifiedBackupAssets(guildId: string, backupId: string) {
  return listBackupAssets(guildId, backupId);
}

export async function storageStatus(guildId: string) {
  return getBackupStorageStatus(guildId);
}

export function hasBackupManagePermission(member: { permissions: { has: (permission: bigint) => boolean } }): boolean {
  return member.permissions.has(PermissionFlagsBits.Administrator);
}
