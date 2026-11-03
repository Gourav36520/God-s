import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const botBackups = pgTable(
  "bot_backups",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: text("status").notNull().default("building"),
    source: text("source").notNull().default("manual"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
    checksum: text("checksum"),
    warningCount: integer("warning_count").notNull().default(0),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("bot_backups_guild_created_idx").on(
      table.guildId,
      table.createdAt,
    ),
    index("bot_backups_guild_status_idx").on(table.guildId, table.status),
  ],
);

export const backupAssets = pgTable(
  "bot_backup_assets",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    backupId: text("backup_id")
      .notNull()
      .references(() => botBackups.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    sourceId: text("source_id").notNull(),
    partIndex: integer("part_index").notNull().default(0),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    data: bytea("data").notNull(),
  },
  (table) => [
    uniqueIndex("bot_backup_assets_unique_idx").on(
      table.backupId,
      table.resourceType,
      table.sourceId,
      table.partIndex,
    ),
    index("bot_backup_assets_guild_backup_idx").on(
      table.guildId,
      table.backupId,
    ),
  ],
);

export const archivedMessages = pgTable(
  "bot_archived_messages",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name").notNull(),
    channelType: text("channel_type").notNull(),
    parentId: text("parent_id"),
    parentName: text("parent_name"),
    messageId: text("message_id").notNull(),
    authorId: text("author_id"),
    authorUsername: text("author_username"),
    content: text("content").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    replyToMessageId: text("reply_to_message_id"),
    embeds: jsonb("embeds").$type<Record<string, unknown>[]>().notNull(),
    attachments: jsonb("attachments")
      .$type<Record<string, unknown>[]>()
      .notNull(),
    editHistory: jsonb("edit_history")
      .$type<{ content: string; editedAt: string | null }[]>()
      .notNull()
      .default([]),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("bot_archived_messages_unique_idx").on(
      table.guildId,
      table.channelId,
      table.messageId,
    ),
    index("bot_archived_messages_channel_created_idx").on(
      table.guildId,
      table.channelId,
      table.createdAt,
    ),
    index("bot_archived_messages_guild_created_idx").on(
      table.guildId,
      table.createdAt,
    ),
  ],
);

export const archivedMessageAssets = pgTable(
  "bot_archived_message_assets",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    partIndex: integer("part_index").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    checksum: text("checksum").notNull(),
    data: bytea("data").notNull(),
  },
  (table) => [
    uniqueIndex("bot_archived_message_assets_unique_idx").on(
      table.guildId,
      table.channelId,
      table.messageId,
      table.partIndex,
    ),
    index("bot_archived_message_assets_guild_idx").on(
      table.guildId,
      table.channelId,
    ),
  ],
);

export const autobackupConfigs = pgTable("bot_autobackup_configs", {
  guildId: text("guild_id").primaryKey(),
  autoBackupOn: boolean("auto_backup_on").notNull().default(false),
  archiveOn: boolean("archive_on").notNull().default(false),
  kickTrackingOn: boolean("kick_tracking_on").notNull().default(false),
  intervalMinutes: integer("interval_minutes").notNull().default(1440),
  retentionCount: integer("retention_count").notNull().default(10),
  notificationChannelId: text("notification_channel_id"),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lastFailure: text("last_failure"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const kickedMemberRecoveries = pgTable(
  "bot_kicked_member_recoveries",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    memberId: text("member_id").notNull(),
    username: text("username").notNull(),
    kickedAt: timestamp("kicked_at", { withTimezone: true }).notNull(),
    executorId: text("executor_id"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    inviteCode: text("invite_code"),
    inviteCreatedAt: timestamp("invite_created_at", { withTimezone: true }),
    inviteDeliveredAt: timestamp("invite_delivered_at", {
      withTimezone: true,
    }),
    deliveryStatus: text("delivery_status").notNull().default("not_sent"),
    rejoinedAt: timestamp("rejoined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bot_kicked_recoveries_guild_kicked_idx").on(
      table.guildId,
      table.kickedAt,
    ),
    index("bot_kicked_recoveries_guild_member_idx").on(
      table.guildId,
      table.memberId,
      table.kickedAt,
    ),
  ],
);

export const backupInteractionSessions = pgTable(
  "bot_backup_interaction_sessions",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    kind: text("kind").notNull(),
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bot_backup_sessions_guild_expiry_idx").on(
      table.guildId,
      table.expiresAt,
    ),
  ],
);

export type BotBackup = typeof botBackups.$inferSelect;
export type NewBotBackup = typeof botBackups.$inferInsert;
export type BackupAsset = typeof backupAssets.$inferSelect;
export type ArchivedMessage = typeof archivedMessages.$inferSelect;
export type NewArchivedMessage = typeof archivedMessages.$inferInsert;
export type ArchivedMessageAsset = typeof archivedMessageAssets.$inferSelect;
export type AutobackupConfig = typeof autobackupConfigs.$inferSelect;
export type KickedMemberRecovery = typeof kickedMemberRecoveries.$inferSelect;
export type BackupInteractionSession =
  typeof backupInteractionSessions.$inferSelect;
