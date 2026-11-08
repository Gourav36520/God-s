import {
  AuditLogEvent,
  Events,
  PermissionFlagsBits,
  type Client,
  type GuildAuditLogsEntry,
  type GuildMember,
  type Message,
  type PartialMessage,
} from "discord.js";
import {
  getArchivedMessage,
  insertMemberRemovalEvent,
  insertKickedMemberRecovery,
  markArchivedMessageDeleted,
  markKickedMemberRejoined,
  upsertArchivedMessage,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { archiveDeletedMessage, archiveDiscordMessage, getBackupConfig } from "./backup-service.js";

const AUDIT_LOOKBACK_MS = 15_000;
const AUDIT_FUTURE_SKEW_MS = 5_000;
const AUDIT_LOOKUP_DELAYS_MS = [1_000, 1_250, 1_500] as const;

function logFailure(label: string, error: unknown): void {
  logger.warn(
    `[BACKUP] ${label}: ${
      error instanceof Error ? error.message.slice(0, 300) : "operation failed"
    }`,
  );
}

async function fetchFullMessage(
  message: Message | PartialMessage,
): Promise<Message | null> {
  if (!message.partial) return message as Message;
  return message.fetch().catch(() => null);
}

async function onMessageCreate(message: Message): Promise<void> {
  await archiveDiscordMessage(message).catch((error: unknown) =>
    logFailure(`could not archive message ${message.id}`, error),
  );
}

async function onMessageUpdate(
  _oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> {
  const fullMessage = await fetchFullMessage(newMessage);
  if (!fullMessage) return;
  await archiveDiscordMessage(fullMessage).catch((error: unknown) =>
    logFailure(`could not archive edited message ${fullMessage.id}`, error),
  );
}

async function onMessageDelete(
  message: Message | PartialMessage,
): Promise<void> {
  if (!message.guildId) return;
  const config = await getBackupConfig(message.guildId).catch(() => null);
  if (!config?.archiveOn) return;
  const fullMessage = await fetchFullMessage(message);
  if (fullMessage) {
    await archiveDeletedMessage(fullMessage).catch((error: unknown) =>
      logFailure(`could not archive deleted message ${message.id}`, error),
    );
    return;
  }

  const channelId = message.channelId;
  const prior = await getArchivedMessage(message.guildId, channelId, message.id).catch(() => null);
  if (prior) {
    await markArchivedMessageDeleted(message.guildId, channelId, message.id);
    return;
  }
  const channel = message.channel;
  const guild = message.client.guilds.cache.get(message.guildId);
  if (!guild) return;
  const channelName =
    ("name" in channel ? channel.name : null) || channel.id;
  await upsertArchivedMessage(
    {
      guildId: message.guildId,
      channelId,
      channelName,
      channelType: String(channel.type),
      parentId: "parentId" in channel ? channel.parentId : null,
      parentName:
        "parent" in channel && channel.parent && "name" in channel.parent
          ? channel.parent.name
          : null,
      messageId: message.id,
      authorId: null,
      authorUsername: null,
      content: "",
      createdAt: null,
      editedAt: null,
      deletedAt: new Date(),
      replyToMessageId: null,
      embeds: [],
      attachments: [],
      editHistory: [],
    },
    [],
  );
}

export function isRecentRemovalAuditMatch(
  entry: { targetId: string | null; createdTimestamp: number },
  memberId: string,
  observedAt: number,
  now: number,
): boolean {
  return (
    entry.targetId === memberId &&
    entry.createdTimestamp >= observedAt - AUDIT_LOOKBACK_MS &&
    entry.createdTimestamp <= Math.min(
      observedAt + AUDIT_FUTURE_SKEW_MS,
      now + AUDIT_FUTURE_SKEW_MS,
    )
  );
}

export type MemberRemovalClassification = "kick" | "ban" | "leave" | "unknown";

export function classifyMemberRemoval(
  banMatches: number,
  kickMatches: number,
): MemberRemovalClassification {
  if (banMatches === 1 && kickMatches === 0) return "ban";
  if (kickMatches === 1 && banMatches === 0) return "kick";
  if (kickMatches === 0 && banMatches === 0) return "leave";
  return "unknown";
}

async function recentAuditMatches(
  member: GuildMember,
  type: AuditLogEvent,
  observedAt: number,
): Promise<GuildAuditLogsEntry[]> {
  const result = await member.guild.fetchAuditLogs({ type, limit: 10 });
  return [...result.entries.values()].filter((entry) =>
    isRecentRemovalAuditMatch(
      entry,
      member.id,
      observedAt,
      Date.now(),
    ),
  );
}

async function correlateMemberRemoval(
  member: GuildMember,
  observedAt: Date,
): Promise<{
  classification: MemberRemovalClassification;
  matchedEntry: GuildAuditLogsEntry | null;
  banEntries: GuildAuditLogsEntry[];
  kickEntries: GuildAuditLogsEntry[];
  auditLookupAvailable: boolean;
  attempts: number;
  lookupFailure: string | null;
}> {
  const bans = new Map<string, GuildAuditLogsEntry>();
  const kicks = new Map<string, GuildAuditLogsEntry>();
  let auditLookupAvailable = true;
  let lookupFailure: string | null = null;
  let attempts = 0;

  for (const delayMs of AUDIT_LOOKUP_DELAYS_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    attempts += 1;
    try {
      const [banEntries, kickEntries] = await Promise.all([
        recentAuditMatches(member, AuditLogEvent.MemberBanAdd, observedAt.getTime()),
        recentAuditMatches(member, AuditLogEvent.MemberKick, observedAt.getTime()),
      ]);
      for (const entry of banEntries) bans.set(entry.id, entry);
      for (const entry of kickEntries) kicks.set(entry.id, entry);
    } catch (error) {
      auditLookupAvailable = false;
      lookupFailure =
        error instanceof Error
          ? error.message.slice(0, 220)
          : "Audit-log lookup failed.";
    }
  }

  const banEntries = [...bans.values()];
  const kickEntries = [...kicks.values()];
  const classification = auditLookupAvailable
    ? classifyMemberRemoval(banEntries.length, kickEntries.length)
    : "unknown";
  const matchedEntry =
    classification === "ban"
      ? banEntries[0] ?? null
      : classification === "kick"
        ? kickEntries[0] ?? null
        : null;
  return {
    classification,
    matchedEntry,
    banEntries,
    kickEntries,
    auditLookupAvailable,
    attempts,
    lookupFailure,
  };
}

async function onMemberRemove(member: GuildMember): Promise<void> {
  const config = await getBackupConfig(member.guild.id).catch(() => null);
  if (!config?.kickTrackingOn) return;

  const observedAt = new Date();
  const botMember =
    member.guild.members.me ??
    (await member.guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    await insertMemberRemovalEvent({
      guildId: member.guild.id,
      memberId: member.id,
      username: member.user.username,
      removedAt: observedAt,
      classification: "unknown",
      executorId: null,
      evidence: {
        classification: "unknown",
        auditLookupAvailable: false,
        reason: "The bot lacks View Audit Log permission.",
      },
    }).catch((error: unknown) =>
      logFailure(`could not store removal event for ${member.id}`, error),
    );
    return;
  }

  try {
    const correlation = await correlateMemberRemoval(member, observedAt);
    const {
      classification,
      matchedEntry,
      banEntries,
      kickEntries,
      auditLookupAvailable,
      attempts,
      lookupFailure,
    } = correlation;
    const executorId = matchedEntry?.executorId ?? matchedEntry?.executor?.id ?? null;
    const removedAt = matchedEntry
      ? new Date(matchedEntry.createdTimestamp)
      : observedAt;
    const evidence = {
      classification,
      auditLookupAvailable,
      auditLookupAttempts: attempts,
      matchingBanAuditEntryIds: banEntries.map((entry) => entry.id),
      matchingKickAuditEntryIds: kickEntries.map((entry) => entry.id),
      executorKnown: executorId !== null,
      note:
        classification === "leave"
          ? "No matching ban or kick audit entry was found after repeated audit-log checks."
          : classification === "unknown"
            ? lookupFailure
              ? `Audit logs were not consistently available: ${lookupFailure}`
              : "Audit evidence was ambiguous; no action or executor was inferred."
            : null,
    };
    await insertMemberRemovalEvent({
      guildId: member.guild.id,
      memberId: member.id,
      username: member.user.username,
      removedAt,
      classification,
      executorId:
        classification === "kick" || classification === "ban"
          ? executorId
          : null,
      evidence,
    }).catch((error: unknown) =>
      logFailure(`could not store removal event for ${member.id}`, error),
    );

    if (classification !== "kick" || !matchedEntry) return;
    await insertKickedMemberRecovery({
      guildId: member.guild.id,
      memberId: member.id,
      username: member.user.username,
      kickedAt: removedAt,
      executorId,
      evidence: {
        ...evidence,
        auditEntryId: matchedEntry.id,
        action: "member_kick",
        targetId: member.id,
      },
    });
  } catch (error) {
    logFailure(`could not correlate member removal for ${member.id}`, error);
    await insertMemberRemovalEvent({
      guildId: member.guild.id,
      memberId: member.id,
      username: member.user.username,
      removedAt: observedAt,
      classification: "unknown",
      executorId: null,
      evidence: {
        classification: "unknown",
        auditLookupAvailable: false,
        reason:
          error instanceof Error
            ? error.message.slice(0, 250)
            : "Audit-log lookup failed.",
      },
    }).catch((storeError: unknown) =>
      logFailure(`could not store unknown removal event for ${member.id}`, storeError),
    );
  }
}

async function onMemberAdd(member: GuildMember): Promise<void> {
  await markKickedMemberRejoined(member.guild.id, member.id).catch((error: unknown) =>
    logFailure(`could not update rejoin status for ${member.id}`, error),
  );
}

export function registerBackupEvents(client: Client): void {
  client.on(Events.MessageCreate, (message) => void onMessageCreate(message));
  client.on(Events.MessageUpdate, (oldMessage, newMessage) =>
    void onMessageUpdate(oldMessage, newMessage),
  );
  client.on(Events.MessageDelete, (message) => void onMessageDelete(message));
  client.on(Events.GuildMemberRemove, (member) =>
    void onMemberRemove(member as unknown as GuildMember),
  );
  client.on(Events.GuildMemberAdd, (member) =>
    void onMemberAdd(member as unknown as GuildMember),
  );
}
