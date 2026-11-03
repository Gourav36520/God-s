import {
  AuditLogEvent,
  Events,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type Message,
  type PartialMessage,
} from "discord.js";
import {
  getArchivedMessage,
  insertKickedMemberRecovery,
  markArchivedMessageDeleted,
  markKickedMemberRejoined,
  upsertArchivedMessage,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { archiveDeletedMessage, archiveDiscordMessage, getBackupConfig } from "./backup-service.js";

const AUDIT_CORRELATION_WINDOW_MS = 20_000;

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
  const channelName = "name" in channel ? channel.name : channel.id;
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

function isRecentAuditEntry(
  entry: { target?: { id?: string } | null; createdTimestamp: number },
  memberId: string,
  now: number,
): boolean {
  return (
    entry.target?.id === memberId &&
    Math.abs(now - entry.createdTimestamp) <= AUDIT_CORRELATION_WINDOW_MS
  );
}

async function recentAuditEntry(
  member: GuildMember,
  type: AuditLogEvent,
): Promise<Awaited<ReturnType<typeof member.guild.fetchAuditLogs>>["entries"] extends never ? never : any> {
  const result = await member.guild.fetchAuditLogs({ type, limit: 10 });
  return [...result.entries.values()].find((entry) =>
    isRecentAuditEntry(entry, member.id, Date.now()),
  ) ?? null;
}

async function onMemberRemove(member: GuildMember): Promise<void> {
  const config = await getBackupConfig(member.guild.id).catch(() => null);
  if (!config?.kickTrackingOn) return;

  await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
  const botMember =
    member.guild.members.me ??
    (await member.guild.members.fetchMe().catch(() => null));
  if (!botMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    logger.warn(
      `[BACKUP] Kick tracking skipped for guild ${member.guild.id}: View Audit Log permission is missing.`,
    );
    return;
  }

  try {
    const [banEntry, kickEntry] = await Promise.all([
      recentAuditEntry(member, AuditLogEvent.MemberBanAdd),
      recentAuditEntry(member, AuditLogEvent.MemberKick),
    ]);
    if (banEntry || !kickEntry) return;

    const executorId = kickEntry.executor?.id ?? null;
    await insertKickedMemberRecovery({
      guildId: member.guild.id,
      memberId: member.id,
      username: member.user.username,
      kickedAt: new Date(kickEntry.createdTimestamp),
      executorId,
      evidence: {
        auditEntryId: kickEntry.id,
        action: "member_kick",
        targetId: member.id,
        executorKnown: executorId !== null,
      },
    });
  } catch (error) {
    logFailure(`could not correlate member removal for ${member.id}`, error);
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
  client.on(Events.GuildMemberRemove, (member) => void onMemberRemove(member));
  client.on(Events.GuildMemberAdd, (member) => void onMemberAdd(member));
}
