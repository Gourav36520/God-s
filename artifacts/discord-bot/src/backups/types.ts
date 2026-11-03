export const BACKUP_FORMAT_VERSION = 1 as const;

export type BackupResource =
  | "settings"
  | "roles"
  | "channels"
  | "emojis"
  | "messages"
  | "kicked-members";

export interface BackupAttachment {
  fileName: string;
  contentType: string;
  byteSize: number;
  archived: boolean;
  unavailableReason?: string;
}

export interface BackupMessage {
  id: string;
  channelId: string;
  channelName: string;
  channelType: string;
  parentId: string | null;
  parentName: string | null;
  authorId: string | null;
  authorUsername: string | null;
  content: string;
  createdAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  replyToMessageId: string | null;
  embeds: Record<string, unknown>[];
  attachments: BackupAttachment[];
  editHistory: { content: string; editedAt: string | null }[];
}

export interface BackupRole {
  id: string;
  name: string;
  permissions: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  managed: boolean;
}

export interface BackupPermissionOverwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

export interface BackupChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parentId: string | null;
  topic: string | null;
  nsfw: boolean;
  rateLimitPerUser: number | null;
  bitrate: number | null;
  userLimit: number | null;
  rtcRegion: string | null;
  defaultAutoArchiveDuration: number | null;
  permissionOverwrites: BackupPermissionOverwrite[];
}

export interface BackupEmoji {
  id: string;
  name: string;
  animated: boolean;
  roles: string[];
  assetArchived: boolean;
}

export interface BackupGuildSettings {
  name: string;
  description: string | null;
  verificationLevel: number;
  defaultMessageNotifications: number;
  explicitContentFilter: number;
  afkTimeout: number;
  afkChannelId: string | null;
  systemChannelId: string | null;
  rulesChannelId: string | null;
  publicUpdatesChannelId: string | null;
  preferredLocale: string;
  premiumProgressBarEnabled: boolean;
  systemChannelFlags: number;
}

export interface BackupKick {
  memberId: string;
  username: string;
  kickedAt: string;
  executorId: string | null;
  evidence: Record<string, unknown>;
  deliveryStatus: string;
  rejoinedAt: string | null;
}

export interface BackupSnapshot {
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  guildId: string;
  createdAt: string;
  settings: BackupGuildSettings;
  roles: BackupRole[];
  channels: BackupChannel[];
  emojis: BackupEmoji[];
  messages: BackupMessage[];
  kickedMembers: BackupKick[];
  warnings: string[];
}

export interface BackupAssetInput {
  guildId: string;
  backupId: string;
  resourceType: "message_attachment" | "emoji";
  sourceId: string;
  partIndex: number;
  fileName: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  data: Buffer;
}

export interface BackupSummary {
  roles: number;
  channels: number;
  emojis: number;
  messages: number;
  attachments: number;
  kickedMembers: number;
  unavailableAttachments: number;
  warnings: string[];
}

export interface RestoreReport {
  restored: string[];
  skipped: string[];
  failed: string[];
  warnings: string[];
}
