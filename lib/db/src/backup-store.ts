import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { db } from "./index.js";
import {
  archivedMessageAssets,
  archivedMessages,
  autobackupConfigs,
  backupAssets,
  backupInteractionSessions,
  botBackups,
  kickedMemberRecoveries,
  type AutobackupConfig,
  type BackupInteractionSession,
  type BotBackup,
  type NewArchivedMessage,
} from "./schema/backups.js";

export async function ensureAutobackupConfig(
  guildId: string,
): Promise<AutobackupConfig> {
  await db
    .insert(autobackupConfigs)
    .values({ guildId })
    .onConflictDoNothing();
  const [config] = await db
    .select()
    .from(autobackupConfigs)
    .where(eq(autobackupConfigs.guildId, guildId))
    .limit(1);
  if (!config) throw new Error("Backup configuration could not be loaded.");
  return config;
}

export async function updateAutobackupConfig(
  guildId: string,
  patch: Partial<
    Pick<
      AutobackupConfig,
      | "autoBackupOn"
      | "archiveOn"
      | "kickTrackingOn"
      | "intervalMinutes"
      | "retentionCount"
      | "notificationChannelId"
      | "nextRunAt"
      | "lastSuccessAt"
      | "lastFailureAt"
      | "lastFailure"
      | "updatedBy"
    >
  >,
): Promise<AutobackupConfig> {
  await ensureAutobackupConfig(guildId);
  await db
    .update(autobackupConfigs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(autobackupConfigs.guildId, guildId));
  return ensureAutobackupConfig(guildId);
}

export async function insertBackupRecord(input: {
  id: string;
  guildId: string;
  createdBy: string;
  source: string;
}): Promise<void> {
  await db.insert(botBackups).values({
    ...input,
    status: "building",
  });
}

export async function insertBackupAssets(
  assets: (typeof backupAssets.$inferInsert)[],
): Promise<void> {
  for (let offset = 0; offset < assets.length; offset += 100) {
    await db.insert(backupAssets).values(assets.slice(offset, offset + 100));
  }
}

export async function completeBackupRecord(
  id: string,
  guildId: string,
  details: {
    snapshot: Record<string, unknown>;
    checksum: string;
    warningCount: number;
    summary: Record<string, unknown>;
  },
): Promise<void> {
  const updated = await db
    .update(botBackups)
    .set({
      ...details,
      completedAt: new Date(),
      status: "complete",
    })
    .where(
      and(
        eq(botBackups.id, id),
        eq(botBackups.guildId, guildId),
        eq(botBackups.status, "building"),
      ),
    )
    .returning({ id: botBackups.id });
  if (!updated.length) throw new Error("Backup could not be finalized.");
}

export async function failBackupRecord(
  id: string,
  guildId: string,
  reason: string,
): Promise<void> {
  await db
    .update(botBackups)
    .set({
      status: "failed",
      summary: { failure: reason.slice(0, 500) },
    })
    .where(
      and(
        eq(botBackups.id, id),
        eq(botBackups.guildId, guildId),
        inArray(botBackups.status, ["building", "complete"]),
      ),
    );
}

export async function getBackupRecord(
  guildId: string,
  id: string,
): Promise<BotBackup | null> {
  const [backup] = await db
    .select()
    .from(botBackups)
    .where(
      and(
        eq(botBackups.guildId, guildId),
        eq(botBackups.id, id),
        eq(botBackups.status, "complete"),
      ),
    )
    .limit(1);
  return backup ?? null;
}

export async function listBackupRecords(
  guildId: string,
  limit = 25,
  offset = 0,
): Promise<BotBackup[]> {
  return db
    .select()
    .from(botBackups)
    .where(
      and(eq(botBackups.guildId, guildId), eq(botBackups.status, "complete")),
    )
    .orderBy(desc(botBackups.createdAt))
    .limit(Math.max(1, Math.min(25, limit)))
    .offset(Math.max(0, offset));
}

export async function listBackupAssets(
  guildId: string,
  backupId: string,
): Promise<(typeof backupAssets.$inferSelect)[]> {
  return db
    .select()
    .from(backupAssets)
    .where(
      and(
        eq(backupAssets.guildId, guildId),
        eq(backupAssets.backupId, backupId),
      ),
    )
    .orderBy(asc(backupAssets.id));
}

export async function pruneBackups(
  guildId: string,
  retentionCount: number,
): Promise<number> {
  const keep = Math.max(1, Math.min(100, Math.floor(retentionCount)));
  const rows = await db
    .select({ id: botBackups.id })
    .from(botBackups)
    .where(
      and(eq(botBackups.guildId, guildId), eq(botBackups.status, "complete")),
    )
    .orderBy(desc(botBackups.createdAt))
    .offset(keep);
  const oldIds = rows.map((row) => row.id);
  if (!oldIds.length) return 0;

  const valid = await db
    .select({ id: botBackups.id })
    .from(botBackups)
    .where(
      and(eq(botBackups.guildId, guildId), eq(botBackups.status, "complete")),
    )
    .limit(keep);
  if (!valid.length) return 0;

  const deleted = await db
    .delete(botBackups)
    .where(
      and(
        eq(botBackups.guildId, guildId),
        inArray(botBackups.id, oldIds),
        eq(botBackups.status, "complete"),
      ),
    )
    .returning({ id: botBackups.id });
  return deleted.length;
}

export async function getBackupStorageStatus(
  guildId: string,
): Promise<{ backupCount: number; archiveCount: number; bytes: number }> {
  const [backupStats] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(byte_size), 0)::int`,
    })
    .from(backupAssets)
    .where(eq(backupAssets.guildId, guildId));
  const [archiveStats] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(byte_size), 0)::int`,
    })
    .from(archivedMessageAssets)
    .where(eq(archivedMessageAssets.guildId, guildId));
  const [backupCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(botBackups)
    .where(
      and(eq(botBackups.guildId, guildId), eq(botBackups.status, "complete")),
    );
  return {
    backupCount: backupCount?.count ?? 0,
    archiveCount: archiveStats?.count ?? 0,
    bytes: (backupStats?.bytes ?? 0) + (archiveStats?.bytes ?? 0),
  };
}

export async function upsertArchivedMessage(
  message: NewArchivedMessage,
  assets: (typeof archivedMessageAssets.$inferInsert)[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(archivedMessages)
      .values(message)
      .onConflictDoUpdate({
        target: [
          archivedMessages.guildId,
          archivedMessages.channelId,
          archivedMessages.messageId,
        ],
        set: {
          channelName: message.channelName,
          channelType: message.channelType,
          parentId: message.parentId,
          parentName: message.parentName,
          authorId: message.authorId,
          authorUsername: message.authorUsername,
          content: message.content,
          editedAt: message.editedAt,
          deletedAt: message.deletedAt,
          replyToMessageId: message.replyToMessageId,
          embeds: message.embeds,
          attachments: message.attachments,
          editHistory: message.editHistory ?? [],
          observedAt: new Date(),
        },
      });

    await tx
      .delete(archivedMessageAssets)
      .where(
        and(
          eq(archivedMessageAssets.guildId, message.guildId),
          eq(archivedMessageAssets.channelId, message.channelId),
          eq(archivedMessageAssets.messageId, message.messageId),
        ),
      );
    for (let offset = 0; offset < assets.length; offset += 100) {
      const batch = assets.slice(offset, offset + 100);
      if (batch.length) await tx.insert(archivedMessageAssets).values(batch);
    }

    const oldRows = await tx
      .select({ messageId: archivedMessages.messageId })
      .from(archivedMessages)
      .where(
        and(
          eq(archivedMessages.guildId, message.guildId),
          eq(archivedMessages.channelId, message.channelId),
        ),
      )
      .orderBy(
        desc(
          sql`coalesce(${archivedMessages.createdAt}, ${archivedMessages.observedAt})`,
        ),
        desc(archivedMessages.id),
      )
      .offset(100);
    const oldMessageIds = oldRows.map((row) => row.messageId);
    if (oldMessageIds.length) {
      await tx
        .delete(archivedMessageAssets)
        .where(
          and(
            eq(archivedMessageAssets.guildId, message.guildId),
            eq(archivedMessageAssets.channelId, message.channelId),
            inArray(archivedMessageAssets.messageId, oldMessageIds),
          ),
        );
      await tx
        .delete(archivedMessages)
        .where(
          and(
            eq(archivedMessages.guildId, message.guildId),
            eq(archivedMessages.channelId, message.channelId),
            inArray(archivedMessages.messageId, oldMessageIds),
          ),
        );
    }
  });
}

export async function listArchivedMessages(
  guildId: string,
  channelId?: string,
): Promise<(typeof archivedMessages.$inferSelect)[]> {
  return db
    .select()
    .from(archivedMessages)
    .where(
      channelId
        ? and(
            eq(archivedMessages.guildId, guildId),
            eq(archivedMessages.channelId, channelId),
          )
        : eq(archivedMessages.guildId, guildId),
    )
    .orderBy(asc(archivedMessages.createdAt), asc(archivedMessages.observedAt));
}

export async function getArchivedMessage(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<(typeof archivedMessages.$inferSelect) | null> {
  const [message] = await db
    .select()
    .from(archivedMessages)
    .where(
      and(
        eq(archivedMessages.guildId, guildId),
        eq(archivedMessages.channelId, channelId),
        eq(archivedMessages.messageId, messageId),
      ),
    )
    .limit(1);
  return message ?? null;
}

export async function listArchivedMessageAssets(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<(typeof archivedMessageAssets.$inferSelect)[]> {
  return db
    .select()
    .from(archivedMessageAssets)
    .where(
      and(
        eq(archivedMessageAssets.guildId, guildId),
        eq(archivedMessageAssets.channelId, channelId),
        eq(archivedMessageAssets.messageId, messageId),
      ),
    )
    .orderBy(asc(archivedMessageAssets.partIndex));
}

export async function listAllArchivedMessageAssets(
  guildId: string,
): Promise<(typeof archivedMessageAssets.$inferSelect)[]> {
  return db
    .select()
    .from(archivedMessageAssets)
    .where(eq(archivedMessageAssets.guildId, guildId))
    .orderBy(
      asc(archivedMessageAssets.channelId),
      asc(archivedMessageAssets.messageId),
      asc(archivedMessageAssets.partIndex),
    );
}

export async function markArchivedMessageDeleted(
  guildId: string,
  channelId: string,
  messageId: string,
  knownMessage?: NewArchivedMessage,
): Promise<void> {
  if (knownMessage) {
    await upsertArchivedMessage(
      { ...knownMessage, deletedAt: new Date() },
      [],
    );
    return;
  }
  await db
    .update(archivedMessages)
    .set({ deletedAt: new Date(), observedAt: new Date() })
    .where(
      and(
        eq(archivedMessages.guildId, guildId),
        eq(archivedMessages.channelId, channelId),
        eq(archivedMessages.messageId, messageId),
      ),
    );
}

export async function insertKickedMemberRecovery(input: {
  guildId: string;
  memberId: string;
  username: string;
  kickedAt: Date;
  executorId: string | null;
  evidence: Record<string, unknown>;
}): Promise<void> {
  await db.insert(kickedMemberRecoveries).values(input);
}

export async function listKickedMemberRecoveries(
  guildId: string,
  limit = 25,
  offset = 0,
): Promise<(typeof kickedMemberRecoveries.$inferSelect)[]> {
  return db
    .select()
    .from(kickedMemberRecoveries)
    .where(eq(kickedMemberRecoveries.guildId, guildId))
    .orderBy(desc(kickedMemberRecoveries.kickedAt))
    .limit(Math.max(1, Math.min(1000, limit)))
    .offset(Math.max(0, offset));
}

export async function setKickedMemberInvite(
  guildId: string,
  id: number,
  inviteCode: string,
  deliveryStatus: string,
  delivered: boolean,
): Promise<void> {
  await db
    .update(kickedMemberRecoveries)
    .set({
      inviteCode,
      inviteCreatedAt: new Date(),
      deliveryStatus,
      inviteDeliveredAt: delivered ? new Date() : null,
    })
    .where(
      and(
        eq(kickedMemberRecoveries.guildId, guildId),
        eq(kickedMemberRecoveries.id, id),
      ),
    );
}

export async function markKickedMemberRejoined(
  guildId: string,
  memberId: string,
): Promise<void> {
  const [record] = await db
    .select({ id: kickedMemberRecoveries.id })
    .from(kickedMemberRecoveries)
    .where(
      and(
        eq(kickedMemberRecoveries.guildId, guildId),
        eq(kickedMemberRecoveries.memberId, memberId),
        isNull(kickedMemberRecoveries.rejoinedAt),
      ),
    )
    .orderBy(desc(kickedMemberRecoveries.kickedAt))
    .limit(1);
  if (!record) return;
  await db
    .update(kickedMemberRecoveries)
    .set({ rejoinedAt: new Date() })
    .where(
      and(
        eq(kickedMemberRecoveries.guildId, guildId),
        eq(kickedMemberRecoveries.id, record.id),
        isNull(kickedMemberRecoveries.rejoinedAt),
      ),
    );
}

export async function createBackupInteractionSession(input: {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  kind: string;
  state: Record<string, unknown>;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(backupInteractionSessions).values(input);
}

export async function getBackupInteractionSession(
  guildId: string,
  id: string,
): Promise<BackupInteractionSession | null> {
  const [session] = await db
    .select()
    .from(backupInteractionSessions)
    .where(
      and(
        eq(backupInteractionSessions.guildId, guildId),
        eq(backupInteractionSessions.id, id),
        gt(backupInteractionSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return session ?? null;
}

export async function updateBackupInteractionSession(
  guildId: string,
  id: string,
  state: Record<string, unknown>,
): Promise<void> {
  await db
    .update(backupInteractionSessions)
    .set({ state, updatedAt: new Date() })
    .where(
      and(
        eq(backupInteractionSessions.guildId, guildId),
        eq(backupInteractionSessions.id, id),
      ),
    );
}

export async function deleteExpiredBackupSessions(
  now = new Date(),
): Promise<void> {
  await db
    .delete(backupInteractionSessions)
    .where(lte(backupInteractionSessions.expiresAt, now));
}

export async function getDueAutobackupConfigs(
  now = new Date(),
  limit = 10,
): Promise<AutobackupConfig[]> {
  return db
    .select()
    .from(autobackupConfigs)
    .where(
      and(
        eq(autobackupConfigs.autoBackupOn, true),
        lte(autobackupConfigs.nextRunAt, now),
      ),
    )
    .orderBy(asc(autobackupConfigs.nextRunAt))
    .limit(Math.max(1, Math.min(50, limit)));
}

export async function getBackupCount(guildId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(botBackups)
    .where(
      and(eq(botBackups.guildId, guildId), eq(botBackups.status, "complete")),
    );
  return row?.count ?? 0;
}
