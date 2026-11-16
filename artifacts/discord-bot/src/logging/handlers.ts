import {
  AuditLogEvent,
  Channel,
  Client,
  Events,
  GuildChannel,
  GuildMember,
  GuildTextBasedChannel,
  Message,
  PartialGuildMember,
  PartialMessage,
  ReadonlyCollection,
  Role,
  User,
} from "discord.js";
import { loggingService } from "../lib/registry.js";
import { logger } from "../lib/logger.js";

export function registerLoggingHandlers(client: Client): void {
  // ─── Messages ─────────────────────────────────────────────────────────────

  client.on(Events.MessageDelete, async (message: Message | PartialMessage) => {
    if (!message.guildId) return;
    if (message.author?.bot) return;
    await loggingService.logMessageDelete(message).catch((err) =>
      logger.warn("Log error [messageDelete]:", err)
    );
  });

  client.on(
    Events.MessageUpdate,
    async (oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) => {
      if (!newMessage.guildId) return;
      if (newMessage.author?.bot) return;
      await loggingService.logMessageEdit(oldMessage, newMessage).catch((err) =>
        logger.warn("Log error [messageUpdate]:", err)
      );
    }
  );

  client.on(
    Events.MessageBulkDelete,
    async (
      messages: ReadonlyCollection<string, Message | PartialMessage>,
      channel: GuildTextBasedChannel
    ) => {
      if (!("guildId" in channel)) return;
      await loggingService
        .logBulkDelete(messages as never, channel as unknown as GuildChannel)
        .catch((err) => logger.warn("Log error [messageBulkDelete]:", err));
    }
  );

  // ─── Members ──────────────────────────────────────────────────────────────

  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    await loggingService.logMemberJoin(member).catch((err) =>
      logger.warn("Log error [guildMemberAdd]:", err)
    );
  });

  client.on(
    Events.GuildMemberRemove,
    async (member: GuildMember | PartialGuildMember) => {
      await loggingService.logMemberLeave(member).catch((err) =>
        logger.warn("Log error [guildMemberRemove]:", err)
      );
    }
  );

  client.on(
    Events.GuildMemberUpdate,
    async (oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) => {
      await loggingService.logMemberUpdate(oldMember, newMember).catch((err) =>
        logger.warn("Log error [guildMemberUpdate]:", err)
      );
    }
  );

  /**
   * UserUpdate fires for global user profile changes: username, global display
   * name, and avatar. We iterate every guild the bot shares with this user
   * and log to each guild's member log channel.
   *
   * Requires GuildMembers privileged intent for full coverage. Falls back to
   * members in the bot's in-memory cache when the intent is unavailable.
   */
  client.on(Events.UserUpdate, async (oldUser: User, newUser: User) => {
    const hasChanges =
      oldUser.username !== newUser.username ||
      oldUser.globalName !== newUser.globalName ||
      oldUser.avatar !== newUser.avatar;

    if (!hasChanges) return;

    for (const guild of client.guilds.cache.values()) {
      const member =
        guild.members.cache.get(newUser.id) ??
        (await guild.members.fetch(newUser.id).catch(() => null));
      if (!member) continue;

      await loggingService
        .logUserUpdate(guild.id, oldUser, newUser)
        .catch((err) => logger.warn(`Log error [userUpdate] guild=${guild.id}:`, err));
    }
  });

  // ─── Channels ─────────────────────────────────────────────────────────────

  client.on(Events.ChannelCreate, async (channel: GuildChannel) => {
    await loggingService
      .logChannelCreate(channel as unknown as Channel)
      .catch((err) => logger.warn("Log error [channelCreate]:", err));
  });

  client.on(Events.ChannelDelete, async (channel: Channel | GuildChannel) => {
    await loggingService
      .logChannelDelete(channel as Channel)
      .catch((err) => logger.warn("Log error [channelDelete]:", err));
  });

  client.on(
    Events.ChannelUpdate,
    async (oldChannel: Channel | GuildChannel, newChannel: Channel | GuildChannel) => {
      await loggingService
        .logChannelUpdate(oldChannel as Channel, newChannel as Channel)
        .catch((err) => logger.warn("Log error [channelUpdate]:", err));
    }
  );

  // ─── Roles ────────────────────────────────────────────────────────────────

  /**
   * Wait 1.5 s before logging role creation so the audit log entry has time
   * to propagate. This allows logRoleCreate to resolve the creator's identity.
   */
  client.on(Events.GuildRoleCreate, async (role: Role) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
    await loggingService
      .logRoleCreate(role)
      .catch((err) => logger.warn("Log error [roleCreate]:", err));
  });

  client.on(Events.GuildRoleDelete, async (role: Role) => {
    await loggingService
      .logRoleDelete(role)
      .catch((err) => logger.warn("Log error [roleDelete]:", err));
  });

  client.on(Events.GuildRoleUpdate, async (oldRole: Role, newRole: Role) => {
    await loggingService
      .logRoleUpdate(oldRole, newRole)
      .catch((err) => logger.warn("Log error [roleUpdate]:", err));
  });

  // ─── Audit log (ban / kick / timeout) ────────────────────────────────────

  client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    const watched = [
      AuditLogEvent.MemberBanAdd,
      AuditLogEvent.MemberBanRemove,
      AuditLogEvent.MemberKick,
      AuditLogEvent.MemberUpdate,
    ];

    if (!watched.includes(entry.action as (typeof watched)[number])) return;

    await loggingService
      .logAuditAction(guild.id, entry)
      .catch((err) => logger.warn("Log error [auditLog]:", err));
  });

  logger.info("LoggingService: registered all event handlers");
}
