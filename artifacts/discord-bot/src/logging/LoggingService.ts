import {
  AuditLogEvent,
  Channel,
  Collection,
  EmbedBuilder,
  GuildAuditLogsEntry,
  GuildChannel,
  GuildMember,
  Message,
  PartialGuildMember,
  PartialMessage,
  Role,
  TextChannel,
  User,
} from "discord.js";
import type { Client } from "discord.js";
import type { SecurityManager } from "../security/SecurityManager.js";
import type { LogCategory } from "./types.js";
import { logger } from "../lib/logger.js";

function formatPermissions(perms: string[]): string {
  if (perms.length === 0) return "None";
  const human = perms.map((p) => p.replace(/([A-Z])/g, " $1").trim());
  const text = human.join(", ");
  return text.length > 950 ? text.slice(0, 947) + "…" : text;
}

export class LoggingService {
  private client: Client | null = null;
  private manager: SecurityManager | null = null;

  init(client: Client, manager: SecurityManager): void {
    this.client = client;
    this.manager = manager;
    logger.info("LoggingService: initialized");
  }

  isEnabled(guildId: string, category: LogCategory): boolean {
    if (!this.manager) return false;
    const config = this.manager.getConfig(guildId);
    return config.logging.categories[category] ?? false;
  }

  /**
   * Returns the channel ID to log a given category for a guild.
   * Priority: per-category channel → global logging channel → legacy logChannelId
   */
  private getChannelId(guildId: string, category: LogCategory): string | null {
    if (!this.manager) return null;
    const config = this.manager.getConfig(guildId);
    return (
      config.logging.channelIds?.[category] ??
      config.logging.channelId ??
      config.logChannelId ??
      null
    );
  }

  private async send(guildId: string, category: LogCategory, embed: EmbedBuilder): Promise<void> {
    if (!this.client) return;
    if (!this.isEnabled(guildId, category)) return;

    const channelId = this.getChannelId(guildId, category);
    if (!channelId) {
      logger.warn(
        `LoggingService: no channel configured for category "${category}" in guild ${guildId} — skipping log`
      );
      return;
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({ embeds: [embed] });
      }
    } catch (err) {
      logger.warn(`LoggingService: failed to send ${category} log to ${channelId}:`, err);
    }
  }

  // ─── Moderation ────────────────────────────────────────────────────────────

  async logJudgment(options: {
    guildId: string;
    target: GuildMember;
    moderatorId: string;
    reason: string;
    savedRoles: string[];
  }): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("⚖️ God's Judgment — User Judged")
      .setColor(0xfee75c)
      .setThumbnail(options.target.user.displayAvatarURL())
      .addFields(
        { name: "User", value: `${options.target.user.tag}\n<@${options.target.id}>`, inline: true },
        { name: "Moderator", value: `<@${options.moderatorId}>`, inline: true },
        { name: "Reason", value: options.reason, inline: false },
        {
          name: `Saved Roles (${options.savedRoles.length})`,
          value: options.savedRoles.length > 0
            ? options.savedRoles.map((r) => `<@&${r}>`).join(", ")
            : "None",
          inline: false,
        }
      )
      .setFooter({ text: `User ID: ${options.target.id}` })
      .setTimestamp();

    await this.send(options.guildId, "moderation", embed);
  }

  async logRelease(options: {
    guildId: string;
    target: GuildMember;
    moderatorId: string;
    reason: string;
    restoredRoles: string[];
    skippedRoles: number;
  }): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("✅ God's Judgment — User Released")
      .setColor(0x57f287)
      .setThumbnail(options.target.user.displayAvatarURL())
      .addFields(
        { name: "User", value: `${options.target.user.tag}\n<@${options.target.id}>`, inline: true },
        { name: "Released By", value: `<@${options.moderatorId}>`, inline: true },
        { name: "Reason", value: options.reason, inline: false },
        {
          name: `Roles Restored (${options.restoredRoles.length})`,
          value: options.restoredRoles.length > 0
            ? options.restoredRoles.map((r) => `<@&${r}>`).join(", ")
            : "None",
          inline: false,
        },
        ...(options.skippedRoles > 0
          ? [{ name: "Skipped", value: `${options.skippedRoles} deleted role(s) could not be restored.`, inline: false }]
          : [])
      )
      .setFooter({ text: `User ID: ${options.target.id}` })
      .setTimestamp();

    await this.send(options.guildId, "moderation", embed);
  }

  async logAuditAction(guildId: string, entry: GuildAuditLogsEntry): Promise<void> {
    let embed: EmbedBuilder | null = null;

    const executor = entry.executor;
    const target = entry.target as User | GuildMember | null;
    const reason = entry.reason ?? "No reason provided";
    const targetTag = target instanceof User
      ? target.tag
      : target instanceof GuildMember
        ? target.user.tag
        : "Unknown";
    const targetId = target?.id ?? "Unknown";
    const executorField = executor ? `${executor.tag}\n<@${executor.id}>` : "Unknown";

    switch (entry.action) {
      case AuditLogEvent.MemberBanAdd:
        embed = new EmbedBuilder()
          .setTitle("🔨 Member Banned")
          .setColor(0xed4245)
          .addFields(
            { name: "User", value: `${targetTag}\n<@${targetId}>`, inline: true },
            { name: "Moderator", value: executorField, inline: true },
            { name: "Reason", value: reason, inline: false }
          )
          .setFooter({ text: `User ID: ${targetId}` })
          .setTimestamp();
        break;

      case AuditLogEvent.MemberBanRemove:
        embed = new EmbedBuilder()
          .setTitle("✅ Member Unbanned")
          .setColor(0x57f287)
          .addFields(
            { name: "User", value: `${targetTag}\n<@${targetId}>`, inline: true },
            { name: "Moderator", value: executorField, inline: true },
            { name: "Reason", value: reason, inline: false }
          )
          .setFooter({ text: `User ID: ${targetId}` })
          .setTimestamp();
        break;

      case AuditLogEvent.MemberKick:
        embed = new EmbedBuilder()
          .setTitle("👢 Member Kicked")
          .setColor(0xe67e22)
          .addFields(
            { name: "User", value: `${targetTag}\n<@${targetId}>`, inline: true },
            { name: "Moderator", value: executorField, inline: true },
            { name: "Reason", value: reason, inline: false }
          )
          .setFooter({ text: `User ID: ${targetId}` })
          .setTimestamp();
        break;

      case AuditLogEvent.MemberUpdate: {
        const timeoutChange = entry.changes.find((c) => c.key === "communication_disabled_until");
        if (!timeoutChange) break;

        const wasTimedOut = !timeoutChange.old && timeoutChange.new;
        const timedOutUntil = timeoutChange.new
          ? `<t:${Math.floor(new Date(timeoutChange.new as string).getTime() / 1000)}:R>`
          : null;

        if (wasTimedOut && timedOutUntil) {
          embed = new EmbedBuilder()
            .setTitle("⏱️ Member Timed Out")
            .setColor(0xe67e22)
            .addFields(
              { name: "User", value: `${targetTag}\n<@${targetId}>`, inline: true },
              { name: "Moderator", value: executorField, inline: true },
              { name: "Expires", value: timedOutUntil, inline: true },
              { name: "Reason", value: reason, inline: false }
            )
            .setFooter({ text: `User ID: ${targetId}` })
            .setTimestamp();
        } else if (!wasTimedOut && !timeoutChange.new) {
          embed = new EmbedBuilder()
            .setTitle("✅ Timeout Removed")
            .setColor(0x57f287)
            .addFields(
              { name: "User", value: `${targetTag}\n<@${targetId}>`, inline: true },
              { name: "Moderator", value: executorField, inline: true }
            )
            .setFooter({ text: `User ID: ${targetId}` })
            .setTimestamp();
        }
        break;
      }
    }

    if (embed) {
      await this.send(guildId, "moderation", embed);
    }
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

  async logMessageDelete(message: Message | PartialMessage): Promise<void> {
    if (!message.guildId) return;

    const content = message.partial || !message.content
      ? "*Message content unavailable (not cached)*"
      : message.content.length > 1024
        ? message.content.slice(0, 1021) + "..."
        : message.content;

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Message Deleted")
      .setColor(0xed4245)
      .addFields(
        { name: "Author", value: message.author ? `${message.author.tag}\n<@${message.author.id}>` : "Unknown", inline: true },
        { name: "Channel", value: `<#${message.channelId}>`, inline: true },
        { name: "Content", value: content, inline: false }
      )
      .setFooter({ text: `Message ID: ${message.id}` })
      .setTimestamp();

    if (message.attachments?.size) {
      embed.addFields({
        name: "Attachments",
        value: message.attachments.map((a) => a.url).join("\n"),
        inline: false,
      });
    }

    await this.send(message.guildId, "messages", embed);
  }

  async logMessageEdit(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage): Promise<void> {
    if (!newMessage.guildId) return;
    if (newMessage.author?.bot) return;

    const oldContent = oldMessage.partial || !oldMessage.content
      ? "*Content unavailable*"
      : oldMessage.content.length > 512
        ? oldMessage.content.slice(0, 509) + "..."
        : oldMessage.content;

    const newContent = newMessage.content
      ? newMessage.content.length > 512
        ? newMessage.content.slice(0, 509) + "..."
        : newMessage.content
      : "*Content unavailable*";

    if (oldContent === newContent) return;

    const embed = new EmbedBuilder()
      .setTitle("✏️ Message Edited")
      .setColor(0x5865f2)
      .setURL(newMessage.url)
      .addFields(
        { name: "Author", value: newMessage.author ? `${newMessage.author.tag}\n<@${newMessage.author.id}>` : "Unknown", inline: true },
        { name: "Channel", value: `<#${newMessage.channelId}>`, inline: true },
        { name: "Before", value: oldContent, inline: false },
        { name: "After", value: newContent, inline: false }
      )
      .setFooter({ text: `Message ID: ${newMessage.id}` })
      .setTimestamp();

    await this.send(newMessage.guildId, "messages", embed);
  }

  async logBulkDelete(messages: Collection<string, Message | PartialMessage>, channel: GuildChannel): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("🗑️ Bulk Message Delete")
      .setColor(0xed4245)
      .addFields(
        { name: "Channel", value: `<#${channel.id}>`, inline: true },
        { name: "Messages Deleted", value: messages.size.toString(), inline: true }
      )
      .setFooter({ text: `Channel ID: ${channel.id}` })
      .setTimestamp();

    await this.send(channel.guildId, "messages", embed);
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  async logMemberJoin(member: GuildMember): Promise<void> {
    const accountAge = `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`;

    const embed = new EmbedBuilder()
      .setTitle("📥 Member Joined")
      .setColor(0x57f287)
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: "User", value: `${member.user.tag}\n<@${member.id}>`, inline: true },
        { name: "Account Created", value: accountAge, inline: true },
        { name: "Member Count", value: member.guild.memberCount.toString(), inline: true }
      )
      .setFooter({ text: `User ID: ${member.id}` })
      .setTimestamp();

    await this.send(member.guild.id, "members", embed);
  }

  async logMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
    const roles = member.roles.cache
      .filter((r) => r.id !== member.guild.roles.everyone.id)
      .map((r) => `<@&${r.id}>`);

    const embed = new EmbedBuilder()
      .setTitle("📤 Member Left")
      .setColor(0x99aab5)
      .setThumbnail(member.user?.displayAvatarURL() ?? null)
      .addFields(
        { name: "User", value: `${member.user?.tag ?? "Unknown"}\n<@${member.id}>`, inline: true },
        { name: "Roles", value: roles.length > 0 ? roles.join(", ") : "None", inline: false }
      )
      .setFooter({ text: `User ID: ${member.id}` })
      .setTimestamp();

    await this.send(member.guild.id, "members", embed);
  }

  async logMemberUpdate(
    oldMember: GuildMember | PartialGuildMember,
    newMember: GuildMember
  ): Promise<void> {
    const guildId = newMember.guild.id;
    const everyoneId = newMember.guild.roles.everyone.id;

    // ── Server nickname change ─────────────────────────────────────────────
    const oldNick = oldMember.nickname;
    const newNick = newMember.nickname;
    if (oldNick !== newNick) {
      const embed = new EmbedBuilder()
        .setTitle("🏷️ Server Nickname Changed")
        .setColor(0x5865f2)
        .setThumbnail(newMember.user.displayAvatarURL())
        .addFields(
          { name: "User", value: `${newMember.user.tag}\n<@${newMember.id}>`, inline: true },
          { name: "Before", value: oldNick ?? "*None*", inline: true },
          { name: "After", value: newNick ?? "*Removed*", inline: true }
        )
        .setFooter({ text: `User ID: ${newMember.id}` })
        .setTimestamp();

      await this.send(guildId, "members", embed);
    }

    // ── Role changes — separate embeds for Added and Removed ──────────────
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    const added = newRoles.filter((r) => !oldRoles.has(r.id) && r.id !== everyoneId);
    const removed = oldRoles.filter((r) => !newRoles.has(r.id) && r.id !== everyoneId);

    if (added.size > 0) {
      const embed = new EmbedBuilder()
        .setTitle("✅ Member Role Added")
        .setColor(0x57f287)
        .setThumbnail(newMember.user.displayAvatarURL())
        .addFields(
          { name: "User", value: `${newMember.user.tag}\n<@${newMember.id}>`, inline: true },
          {
            name: `Role${added.size > 1 ? "s" : ""} Added (${added.size})`,
            value: added.map((r) => `<@&${r.id}> \`${r.name}\``).join("\n"),
            inline: false,
          }
        )
        .setFooter({ text: `User ID: ${newMember.id}` })
        .setTimestamp();

      await this.send(guildId, "members", embed);
    }

    if (removed.size > 0) {
      const embed = new EmbedBuilder()
        .setTitle("❌ Member Role Removed")
        .setColor(0xed4245)
        .setThumbnail(newMember.user.displayAvatarURL())
        .addFields(
          { name: "User", value: `${newMember.user.tag}\n<@${newMember.id}>`, inline: true },
          {
            name: `Role${removed.size > 1 ? "s" : ""} Removed (${removed.size})`,
            value: removed.map((r) => `<@&${r.id}> \`${r.name}\``).join("\n"),
            inline: false,
          }
        )
        .setFooter({ text: `User ID: ${newMember.id}` })
        .setTimestamp();

      await this.send(guildId, "members", embed);
    }
  }

  /**
   * Logs user-level profile changes (username, global display name, avatar).
   * Called from the UserUpdate event handler for every guild the user is in.
   */
  async logUserUpdate(guildId: string, oldUser: User, newUser: User): Promise<void> {
    // Username change (Discord pomelo / unique username system)
    if (oldUser.username !== newUser.username) {
      const embed = new EmbedBuilder()
        .setTitle("📝 Username Changed")
        .setColor(0x5865f2)
        .setThumbnail(newUser.displayAvatarURL())
        .addFields(
          { name: "User", value: `${newUser.tag}\n<@${newUser.id}>`, inline: true },
          { name: "Before", value: `\`${oldUser.username}\``, inline: true },
          { name: "After", value: `\`${newUser.username}\``, inline: true }
        )
        .setFooter({ text: `User ID: ${newUser.id}` })
        .setTimestamp();

      await this.send(guildId, "members", embed);
    }

    // Global display name change
    if (oldUser.globalName !== newUser.globalName) {
      const embed = new EmbedBuilder()
        .setTitle("📝 Global Display Name Changed")
        .setColor(0x5865f2)
        .setThumbnail(newUser.displayAvatarURL())
        .addFields(
          { name: "User", value: `${newUser.tag}\n<@${newUser.id}>`, inline: true },
          {
            name: "Before",
            value: oldUser.globalName ? `\`${oldUser.globalName}\`` : "*None*",
            inline: true,
          },
          {
            name: "After",
            value: newUser.globalName ? `\`${newUser.globalName}\`` : "*Removed*",
            inline: true,
          }
        )
        .setFooter({ text: `User ID: ${newUser.id}` })
        .setTimestamp();

      await this.send(guildId, "members", embed);
    }

    // Avatar change (compare hash — null means default avatar)
    if (oldUser.avatar !== newUser.avatar) {
      const embed = new EmbedBuilder()
        .setTitle("🖼️ Avatar Changed")
        .setColor(0x5865f2)
        .setThumbnail(newUser.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "User", value: `${newUser.tag}\n<@${newUser.id}>`, inline: true },
          {
            name: "New Avatar",
            value: `[View full size](${newUser.displayAvatarURL({ size: 1024 })})`,
            inline: true,
          }
        )
        .setFooter({ text: `User ID: ${newUser.id}` })
        .setTimestamp();

      await this.send(guildId, "members", embed);
    }
  }

  // ─── Channels ──────────────────────────────────────────────────────────────

  async logChannelCreate(channel: Channel): Promise<void> {
    if (!channel.isTextBased() && !("name" in channel)) return;
    const gc = channel as GuildChannel;

    const embed = new EmbedBuilder()
      .setTitle("➕ Channel Created")
      .setColor(0x57f287)
      .addFields(
        { name: "Name", value: `<#${gc.id}> \`${gc.name}\``, inline: true },
        { name: "Type", value: gc.type.toString(), inline: true }
      )
      .setFooter({ text: `Channel ID: ${gc.id}` })
      .setTimestamp();

    await this.send(gc.guildId, "channels", embed);
  }

  async logChannelDelete(channel: Channel): Promise<void> {
    if (!("name" in channel)) return;
    const gc = channel as GuildChannel;

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Channel Deleted")
      .setColor(0xed4245)
      .addFields(
        { name: "Name", value: `\`${gc.name}\``, inline: true },
        { name: "Type", value: gc.type.toString(), inline: true }
      )
      .setFooter({ text: `Channel ID: ${gc.id}` })
      .setTimestamp();

    await this.send(gc.guildId, "channels", embed);
  }

  async logChannelUpdate(oldChannel: Channel, newChannel: Channel): Promise<void> {
    if (!("name" in oldChannel) || !("name" in newChannel)) return;
    const oldGC = oldChannel as GuildChannel;
    const newGC = newChannel as GuildChannel;

    const changes: { name: string; value: string; inline: boolean }[] = [];

    if (oldGC.name !== newGC.name) {
      changes.push({ name: "Name", value: `\`${oldGC.name}\` → \`${newGC.name}\``, inline: false });
    }

    if ("topic" in oldGC && "topic" in newGC && oldGC.topic !== newGC.topic) {
      changes.push({
        name: "Topic",
        value: `**Before:** ${(oldGC as TextChannel).topic ?? "*None*"}\n**After:** ${(newGC as TextChannel).topic ?? "*None*"}`,
        inline: false,
      });
    }

    if (changes.length === 0) return;

    const embed = new EmbedBuilder()
      .setTitle("✏️ Channel Updated")
      .setColor(0x5865f2)
      .addFields(
        { name: "Channel", value: `<#${newGC.id}>`, inline: true },
        ...changes
      )
      .setFooter({ text: `Channel ID: ${newGC.id}` })
      .setTimestamp();

    await this.send(newGC.guildId, "channels", embed);
  }

  // ─── Roles ─────────────────────────────────────────────────────────────────

  /**
   * Upgraded role create log: fetches the audit log to get the creator,
   * shows role ID, color, position, hoist, mentionable, and full permission list.
   *
   * NOTE: `logRoleCreate` is called after a 1.5 s delay in handlers.ts so the
   * audit log entry has time to propagate before we query it.
   */
  async logRoleCreate(role: Role): Promise<void> {
    let creatorField = "*Unknown — audit log unavailable*";
    try {
      const auditLogs = await role.guild.fetchAuditLogs({
        type: AuditLogEvent.RoleCreate,
        limit: 5,
      });
      const entry = auditLogs.entries.find(
        (e) => (e.target as { id?: string } | null)?.id === role.id
      );
      if (entry?.executor) {
        creatorField = `${entry.executor.tag}\n<@${entry.executor.id}>`;
      }
    } catch {
      // Bot lacks ViewAuditLog permission — omit creator info silently
    }

    const allPerms = role.permissions.toArray();
    const permCount = allPerms.length;
    const permList = formatPermissions(allPerms);

    const embed = new EmbedBuilder()
      .setTitle("➕ Role Created")
      .setColor(role.color || 0x57f287)
      .addFields(
        { name: "Name", value: `<@&${role.id}> \`${role.name}\``, inline: true },
        { name: "Created By", value: creatorField, inline: true },
        { name: "Role ID", value: `\`${role.id}\``, inline: true },
        { name: "Color", value: role.hexColor, inline: true },
        { name: "Position", value: role.position.toString(), inline: true },
        { name: "Hoisted", value: role.hoist ? "Yes" : "No", inline: true },
        { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
        { name: `Permissions (${permCount})`, value: permList, inline: false }
      )
      .setFooter({ text: `Role ID: ${role.id}` })
      .setTimestamp();

    await this.send(role.guild.id, "roles", embed);
  }

  async logRoleDelete(role: Role): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("🗑️ Role Deleted")
      .setColor(0xed4245)
      .addFields(
        { name: "Name", value: `\`${role.name}\``, inline: true },
        { name: "Color", value: role.hexColor, inline: true },
        { name: "Role ID", value: `\`${role.id}\``, inline: true }
      )
      .setFooter({ text: `Role ID: ${role.id}` })
      .setTimestamp();

    await this.send(role.guild.id, "roles", embed);
  }

  async logRoleUpdate(oldRole: Role, newRole: Role): Promise<void> {
    const changes: { name: string; value: string; inline: boolean }[] = [];

    if (oldRole.name !== newRole.name) {
      changes.push({ name: "Name", value: `\`${oldRole.name}\` → \`${newRole.name}\``, inline: false });
    }
    if (oldRole.color !== newRole.color) {
      changes.push({ name: "Color", value: `${oldRole.hexColor} → ${newRole.hexColor}`, inline: true });
    }
    if (oldRole.position !== newRole.position) {
      changes.push({
        name: "Position",
        value: `${oldRole.position} → ${newRole.position}`,
        inline: true,
      });
    }
    if (oldRole.hoist !== newRole.hoist) {
      changes.push({
        name: "Hoisted",
        value: `${oldRole.hoist ? "Yes" : "No"} → ${newRole.hoist ? "Yes" : "No"}`,
        inline: true,
      });
    }
    if (oldRole.mentionable !== newRole.mentionable) {
      changes.push({
        name: "Mentionable",
        value: `${oldRole.mentionable ? "Yes" : "No"} → ${newRole.mentionable ? "Yes" : "No"}`,
        inline: true,
      });
    }

    // Permission diff
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
      const oldPerms = oldRole.permissions.toArray();
      const newPerms = newRole.permissions.toArray();
      const gained = newPerms.filter((p) => !oldPerms.includes(p));
      const lost = oldPerms.filter((p) => !newPerms.includes(p));

      if (gained.length > 0) {
        changes.push({
          name: `Permissions Added (${gained.length})`,
          value: formatPermissions(gained),
          inline: false,
        });
      }
      if (lost.length > 0) {
        changes.push({
          name: `Permissions Removed (${lost.length})`,
          value: formatPermissions(lost),
          inline: false,
        });
      }
    }

    if (changes.length === 0) return;

    const embed = new EmbedBuilder()
      .setTitle("✏️ Role Updated")
      .setColor(newRole.color || 0x5865f2)
      .addFields(
        { name: "Role", value: `<@&${newRole.id}>`, inline: true },
        ...changes
      )
      .setFooter({ text: `Role ID: ${newRole.id}` })
      .setTimestamp();

    await this.send(newRole.guild.id, "roles", embed);
  }

  // ─── Security ──────────────────────────────────────────────────────────────

  async logSecurityTrigger(options: {
    guildId: string;
    module: string;
    member: GuildMember;
    action: string;
    reason: string;
    extra?: { name: string; value: string; inline?: boolean }[];
  }): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Security Trigger — ${options.module}`)
      .setColor(0xe67e22)
      .setThumbnail(options.member.user.displayAvatarURL())
      .addFields(
        { name: "User", value: `${options.member.user.tag}\n<@${options.member.id}>`, inline: true },
        { name: "Action Taken", value: options.action, inline: true },
        { name: "Reason", value: options.reason, inline: false },
        ...(options.extra ?? [])
      )
      .setFooter({ text: `User ID: ${options.member.id} • ${options.module}` })
      .setTimestamp();

    await this.send(options.guildId, "security", embed);
  }
}
