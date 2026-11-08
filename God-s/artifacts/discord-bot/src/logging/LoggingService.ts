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
  VoiceState,
} from "discord.js";
import type { Client } from "discord.js";
import type { SecurityManager } from "../security/SecurityManager.js";
import type { LogCategory } from "./types.js";
import { logger } from "../lib/logger.js";
import { createGodsEmbed } from "../commands/ui.js";
import {
  actionCardColor,
  moderationActionKeys,
  normalizeSeverity,
  type LogSeverity,
} from "./presentation.js";

type ActionDetail = { name: string; value: string; inline?: boolean };

type ActionLogSource = "audit" | "moderation" | "security";

interface RecentActionLog {
  source: ActionLogSource;
  expiresAt: number;
  pending: boolean;
  message?: Message;
  replacement?: EmbedBuilder;
}

interface ActionCardOptions {
  title: string;
  targetId: string;
  targetLabel: string;
  targetKind?: "user" | "other";
  targetAvatarUrl?: string | null;
  moderatorId?: string | null;
  moderatorLabel?: string | null;
  action: string;
  reason?: string | null;
  severity?: unknown;
  details?: ActionDetail[];
  caseId?: number | string | null;
}

function truncateField(value: string, maxLength = 1_024): string {
  return value.length > maxLength ? value.slice(0, maxLength - 1) + "…" : value;
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "";

  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }

  const formatted =
    unitIndex === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

function getAttachmentDetails(message: Message | PartialMessage): {
  key: string;
  line: string;
}[] {
  return Array.from(message.attachments.values()).map((attachment, index) => {
    const name = (attachment.name?.trim() || `Attachment ${index + 1}`).replace(
      /[\r\n]+/g,
      " ",
    );
    const url = attachment.url?.trim() ?? "";
    const metadata = [
      attachment.contentType?.trim(),
      formatAttachmentSize(attachment.size),
    ].filter(Boolean);
    const detail = [name, url, ...metadata].filter(Boolean).join(" — ");

    return {
      key: [
        attachment.id,
        name,
        url,
        attachment.contentType ?? "",
        attachment.size,
      ].join("\u0000"),
      line: `• ${detail}`,
    };
  });
}

function attachmentSignature(message: Message | PartialMessage): string {
  return getAttachmentDetails(message)
    .map((attachment) => attachment.key)
    .sort()
    .join("\n");
}

function attachmentField(
  message: Message | PartialMessage,
  name = "Attachments",
): ActionDetail | null {
  const details = getAttachmentDetails(message);
  if (details.length === 0) return null;
  return {
    name,
    value: truncateField(details.map((attachment) => attachment.line).join("\n")),
    inline: false,
  };
}

function messageTextSnapshot(message: Message | PartialMessage): string | undefined {
  const text = message.content?.trim() ?? "";
  if (text) return text;
  return message.partial ? undefined : "";
}

function severityFromDetails(details: ActionDetail[] | undefined): LogSeverity | null {
  for (const detail of details ?? []) {
    if (!/severity|heat/i.test(detail.name)) continue;
    const match = detail.value.match(/\b(low|medium|high|critical)\b/i);
    const severity = normalizeSeverity(match?.[1]);
    if (severity) return severity;
  }
  return null;
}

function createLogEmbed(title: string, color: number): EmbedBuilder {
  return createGodsEmbed({ title, description: " ", tone: "info" })
    .setDescription(null)
    .setColor(color);
}

function createActionCard(options: ActionCardOptions): EmbedBuilder {
  const severity = normalizeSeverity(options.severity);
  const isUser = options.targetKind !== "other";
  const targetName = isUser ? "User" : "Target";
  const targetMention =
    isUser && options.targetId !== "Unknown" ? `<@${options.targetId}>` : null;
  const targetLabel =
    options.targetLabel && !options.targetLabel.includes(targetMention ?? "\0")
      ? `${options.targetLabel}${targetMention ? `\n${targetMention}` : ""}`
      : options.targetLabel || targetMention || "Unknown";
  const fields = [
    { name: targetName, value: targetLabel, inline: true },
    {
      name: isUser ? "User ID" : "Target ID",
      value: options.targetId || "Unknown",
      inline: true,
    },
    { name: "Action", value: truncateField(options.action || "Unknown action"), inline: true },
    ...(options.moderatorId
      ? [{
          name: "Moderator",
          value: options.moderatorLabel
            ? `${options.moderatorLabel}\n<@${options.moderatorId}>`
            : `<@${options.moderatorId}>`,
          inline: true,
        }]
      : []),
    ...(severity
      ? [{ name: "Severity", value: severity.toUpperCase(), inline: true }]
      : []),
    {
      name: "Reason",
      value: truncateField(options.reason?.trim() || "No reason provided"),
      inline: false,
    },
    ...(options.details ?? [])
      .filter((field) => field.name.trim() && field.value.trim())
      .map((field) => ({ ...field, value: truncateField(field.value) })),
    ...(options.caseId !== null && options.caseId !== undefined
      ? [{ name: "Case ID", value: String(options.caseId), inline: true }]
      : []),
  ];
  const embed = createLogEmbed(options.title, actionCardColor(severity))
    .addFields(fields);

  if (options.targetAvatarUrl) embed.setThumbnail(options.targetAvatarUrl);
  return embed;
}

function createProfileCard(
  title: string,
  user: User,
  changes: ActionDetail | ActionDetail[],
  beforeImageUrl?: string,
  afterImageUrl?: string,
): EmbedBuilder {
  const profileChanges = Array.isArray(changes) ? changes : [changes];
  const embed = createLogEmbed(title, 0x5865f2)
    .setAuthor({
      name: "Aegis Logs • Profile Update",
      iconURL: user.displayAvatarURL({ size: 64 }),
    })
    .addFields(
      {
        name: "Profile",
        value: truncateField(
          `**${user.globalName ?? user.username}**\n@${user.username}\nID: ${user.id}`,
        ),
        inline: true,
      },
      {
        name: "Before → After",
        value: truncateField(
          profileChanges
            .map((change) => `**${change.name}**\n${change.value}`)
            .join("\n\n"),
        ),
        inline: true,
      },
    );
  if (beforeImageUrl) embed.setImage(beforeImageUrl);
  if (afterImageUrl) embed.setThumbnail(afterImageUrl);
  return embed;
}

function formatPermissions(perms: string[]): string {
  if (perms.length === 0) return "None";
  const human = perms.map((p) => p.replace(/([A-Z])/g, " $1").trim());
  const text = human.join(", ");
  return text.length > 950 ? text.slice(0, 947) + "…" : text;
}

export class LoggingService {
  private client: Client | null = null;
  private manager: SecurityManager | null = null;
  private readonly recentActionLogs = new Map<string, RecentActionLog>();

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

  private async send(
    guildId: string,
    category: LogCategory,
    embed: EmbedBuilder,
  ): Promise<Message | null> {
    if (!this.client) return null;
    if (!this.isEnabled(guildId, category)) return null;

    const channelId = this.getChannelId(guildId, category);
    if (!channelId) {
      logger.warn(
        `LoggingService: no channel configured for category "${category}" in guild ${guildId} — skipping log`
      );
      return null;
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        return await (channel as TextChannel).send({ embeds: [embed] });
      }
    } catch (err) {
      logger.warn(`LoggingService: failed to send ${category} log to ${channelId}:`, err);
    }
    return null;
  }

  private async sendAction(
    guildId: string,
    category: LogCategory,
    embed: EmbedBuilder,
    targetId: string,
    action: string,
    source: ActionLogSource,
  ): Promise<void> {
    const actionKeys = moderationActionKeys(action);
    if (targetId === "Unknown" || actionKeys.length === 0) {
      await this.send(guildId, category, embed);
      return;
    }
    const configuredChannelId = this.getChannelId(guildId, category);
    if (!this.isEnabled(guildId, category) || !configuredChannelId) {
      await this.send(guildId, category, embed);
      return;
    }

    const now = Date.now();
    for (const [key, record] of this.recentActionLogs) {
      if (record.expiresAt <= now) this.recentActionLogs.delete(key);
    }

    const keys = actionKeys.map(
      (actionKey) =>
        `${guildId}:${configuredChannelId}:${targetId}:${actionKey}`,
    );
    const previous = keys
      .map((key) => this.recentActionLogs.get(key))
      .find((record): record is RecentActionLog => Boolean(record));

    if (previous && previous.source !== source) {
      if (source !== "moderation") return;

      previous.source = source;
      previous.expiresAt = now + 5_000;
      previous.replacement = embed;
      if (previous.message) {
        try {
          await previous.message.edit({ embeds: [embed] });
          previous.replacement = undefined;
        } catch (err) {
          logger.warn("LoggingService: failed to update a duplicate action log:", err);
        }
        return;
      }
      if (previous.pending) return;

      previous.pending = true;
      const message = await this.send(guildId, category, embed);
      previous.pending = false;
      previous.message = message ?? undefined;
      previous.replacement = undefined;
      return;
    }

    const record: RecentActionLog = {
      source,
      expiresAt: now + 5_000,
      pending: true,
    };
    for (const key of keys) this.recentActionLogs.set(key, record);

    const message = await this.send(guildId, category, embed);
    record.pending = false;
    record.message = message ?? undefined;
    if (!record.replacement) return;

    if (message) {
      try {
        await message.edit({ embeds: [record.replacement] });
      } catch (err) {
        logger.warn("LoggingService: failed to update a duplicate action log:", err);
      }
    } else {
      record.message =
        (await this.send(guildId, category, record.replacement)) ?? undefined;
    }
    record.replacement = undefined;
  }

  private async resolveSeverity(
    guildId: string,
    userId: string,
    suppliedSeverity?: unknown,
  ): Promise<LogSeverity | null> {
    const supplied = normalizeSeverity(suppliedSeverity);
    if (supplied) return supplied;
    if (!this.manager || userId === "Unknown") return null;

    try {
      return normalizeSeverity(
        (await this.manager.getHeatEngine().view(guildId, userId)).severity,
      );
    } catch (err) {
      logger.warn(
        `LoggingService: failed to resolve heat severity for user ${userId} in guild ${guildId}:`,
        err,
      );
      return null;
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
    const severity = await this.resolveSeverity(
      options.guildId,
      options.target.id,
    );
    const embed = createActionCard({
      title: "God's Judgment",
      targetId: options.target.id,
      targetLabel: options.target.user.tag,
      targetAvatarUrl: options.target.user.displayAvatarURL({ size: 256 }),
      moderatorId: options.moderatorId,
      action: "Judgment",
      reason: options.reason,
      severity,
      details: [{
        name: `Saved Roles (${options.savedRoles.length})`,
        value: options.savedRoles.length > 0
          ? options.savedRoles.map((roleId) => `<@&${roleId}>`).join(", ")
          : "None",
        inline: false,
      }],
    });

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
    const severity = await this.resolveSeverity(
      options.guildId,
      options.target.id,
    );
    const embed = createActionCard({
      title: "God's Judgment",
      targetId: options.target.id,
      targetLabel: options.target.user.tag,
      targetAvatarUrl: options.target.user.displayAvatarURL({ size: 256 }),
      moderatorId: options.moderatorId,
      action: "Release",
      reason: options.reason,
      severity,
      details: [
        {
          name: `Roles Restored (${options.restoredRoles.length})`,
          value: options.restoredRoles.length > 0
            ? options.restoredRoles.map((roleId) => `<@&${roleId}>`).join(", ")
            : "None",
          inline: false,
        },
        ...(options.skippedRoles > 0
          ? [{
              name: "Skipped",
              value: `${options.skippedRoles} deleted role(s) could not be restored.`,
              inline: false,
            }]
          : []),
      ],
    });

    await this.send(options.guildId, "moderation", embed);
  }

  async logModerationCommand(options: {
    guildId: string;
    targetId: string;
    targetLabel: string;
    moderatorId: string;
    action: string;
    reason: string;
    duration?: string;
    caseId?: number | null;
  }): Promise<void> {
    const userActions = new Set([
      "ban",
      "unban",
      "kick",
      "timeout",
      "untimeout",
      "softban",
      "softban-partial",
      "warn",
      "warn-remove",
      "server-mute",
      "server-unmute",
      "server-deafen",
      "server-undeafen",
    ]);
    const isUserAction = userActions.has(options.action.trim().toLowerCase());
    const targetUser = isUserAction && this.client
      ? this.client.users.cache.get(options.targetId) ??
        (await this.client.users.fetch(options.targetId).catch(() => null))
      : null;
    const severity = isUserAction
      ? await this.resolveSeverity(options.guildId, options.targetId)
      : null;
    const embed = createActionCard({
      title: "Moderation Action",
      targetId: options.targetId,
      targetLabel: options.targetLabel || options.targetId,
      targetKind: isUserAction ? "user" : "other",
      targetAvatarUrl: targetUser?.displayAvatarURL({ size: 256 }),
      moderatorId: options.moderatorId,
      action: options.action,
      reason: options.reason,
      severity,
      details: options.duration
        ? [{ name: "Duration", value: options.duration, inline: true }]
        : [],
      caseId: options.caseId,
    });

    await this.sendAction(
      options.guildId,
      "moderation",
      embed,
      options.targetId,
      options.action,
      "moderation",
    );
  }

  async logAuditAction(guildId: string, entry: GuildAuditLogsEntry): Promise<void> {
    const executor = entry.executor;
    const target = entry.target as User | GuildMember | null;
    const reason = entry.reason ?? "No reason provided";
    const targetId = entry.targetId ?? target?.id ?? "Unknown";
    const targetUser = target instanceof GuildMember
      ? target.user
      : target instanceof User
        ? target
        : targetId !== "Unknown"
          ? this.client?.users.cache.get(targetId)
          : undefined;
    const targetLabel = targetUser?.tag ?? targetId;
    let action: string | null = null;
    let details: ActionDetail[] = [];

    switch (entry.action) {
      case AuditLogEvent.MemberBanAdd:
        action = "Ban";
        break;

      case AuditLogEvent.MemberBanRemove:
        action = "Unban";
        break;

      case AuditLogEvent.MemberKick:
        action = "Kick";
        break;

      case AuditLogEvent.MemberUpdate: {
        const timeoutChange = entry.changes.find(
          (change) => change.key === "communication_disabled_until",
        );
        const muteChange = entry.changes.find((change) => change.key === "mute");
        const deafChange = entry.changes.find((change) => change.key === "deaf");

        if (timeoutChange) {
          const oldValue = timeoutChange.old;
          const newValue = timeoutChange.new;
          const wasTimedOut = oldValue !== null && oldValue !== undefined && oldValue !== "";
          const isTimedOut = newValue !== null && newValue !== undefined && newValue !== "";
          if (isTimedOut) {
            action = "Timeout";
            if (typeof newValue === "string") {
              const expiresAt = Date.parse(newValue);
              if (Number.isFinite(expiresAt)) {
                details = [{
                  name: "Expires",
                  value: `<t:${Math.floor(expiresAt / 1_000)}:R>`,
                  inline: true,
                }];
              }
            }
          } else if (wasTimedOut) {
            action = "Untimeout";
          }
        } else if (muteChange) {
          const wasMuted = muteChange.old === true;
          const isMuted = muteChange.new === true;
          if (wasMuted !== isMuted) {
            action = isMuted ? "Server Mute" : "Server Unmute";
          }
        } else if (deafChange) {
          const wasDeafened = deafChange.old === true;
          const isDeafened = deafChange.new === true;
          if (wasDeafened !== isDeafened) {
            action = isDeafened ? "Server Deafen" : "Server Undeafen";
          }
        }
        break;
      }
    }

    if (!action) return;

    const severity = await this.resolveSeverity(guildId, targetId);
    const embed = createActionCard({
      title: "Moderation Action",
      targetId,
      targetLabel,
      targetAvatarUrl: targetUser?.displayAvatarURL({ size: 256 }),
      moderatorId: executor?.id,
      moderatorLabel: executor?.tag,
      action,
      reason,
      severity,
      details,
    });

    if (executor?.id === this.client?.user?.id) {
      await this.sendAction(
        guildId,
        "moderation",
        embed,
        targetId,
        action,
        "audit",
      );
    } else {
      await this.send(guildId, "moderation", embed);
    }
  }

  // ─── Messages ──────────────────────────────────────────────────────────────

  async logMessageCreate(message: Message): Promise<void> {
    if (!message.guildId || message.author.bot || message.system) return;

    const content = message.content?.trim() ?? "";
    const attachments = attachmentField(message);
    if (!content && !attachments) return;

    const fields: ActionDetail[] = [
      {
        name: "Author",
        value: `${message.author.tag}\n<@${message.author.id}>`,
        inline: true,
      },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
    ];
    if (content) {
      fields.push({
        name: "Content",
        value: truncateField(content),
        inline: false,
      });
    }
    if (attachments) fields.push(attachments);

    const embed = createLogEmbed("Message Created", 0x57f287)
      .setURL(message.url)
      .addFields(fields)
      .setFooter({ text: `Gods Bot • Message ID: ${message.id}` })
      .setThumbnail(message.author.displayAvatarURL({ size: 256 }));

    await this.send(message.guildId, "messages", embed);
  }

  async logMessageDelete(message: Message | PartialMessage): Promise<void> {
    if (!message.guildId) return;

    const fields: ActionDetail[] = [
      {
        name: "Author",
        value: message.author
          ? `${message.author.tag}\n<@${message.author.id}>`
          : "Unknown",
        inline: true,
      },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
    ];
    const content = message.content?.trim() ?? "";
    if (content) {
      fields.push({
        name: "Deleted Content",
        value: truncateField(content),
        inline: false,
      });
    }
    const attachments = attachmentField(message);
    if (attachments) fields.push(attachments);

    const embed = createLogEmbed("Message Deleted", 0xed4245)
      .addFields(fields)
      .setFooter({ text: `Gods Bot • Message ID: ${message.id}` });

    if (message.author) {
      embed.setThumbnail(message.author.displayAvatarURL({ size: 256 }));
    }

    await this.send(message.guildId, "messages", embed);
  }

  async logMessageEdit(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage): Promise<void> {
    if (!newMessage.guildId) return;
    if (newMessage.author?.bot) return;

    const oldContent = messageTextSnapshot(oldMessage);
    const newContent = messageTextSnapshot(newMessage);
    const contentChanged =
      oldContent !== undefined && newContent !== undefined
        ? oldContent !== newContent
        : oldContent === undefined &&
          newContent !== undefined &&
          newContent.length > 0;
    const attachmentsChanged =
      attachmentSignature(oldMessage) !== attachmentSignature(newMessage);
    if (!contentChanged && !attachmentsChanged) return;

    const fields: ActionDetail[] = [
      {
        name: "Author",
        value: newMessage.author
          ? `${newMessage.author.tag}\n<@${newMessage.author.id}>`
          : "Unknown",
        inline: true,
      },
      { name: "Channel", value: `<#${newMessage.channelId}>`, inline: true },
    ];

    if (contentChanged) {
      fields.push(
        {
          name: "Previous Content",
          value: truncateField(
            oldContent === undefined ? "Unavailable (not cached)" : oldContent || "No text content",
          ),
          inline: false,
        },
        {
          name: "Updated Content",
          value: truncateField(
            newContent === undefined ? "Unavailable (not cached)" : newContent || "No text content",
          ),
          inline: false,
        },
      );
    }

    if (attachmentsChanged) {
      const previousAttachments = attachmentField(oldMessage, "Previous Attachments");
      const updatedAttachments = attachmentField(newMessage, "Updated Attachments");
      fields.push(
        previousAttachments ?? {
          name: "Previous Attachments",
          value: "None",
          inline: false,
        },
        updatedAttachments ?? {
          name: "Updated Attachments",
          value: "None",
          inline: false,
        },
      );
    } else {
      const attachments = attachmentField(newMessage);
      if (attachments) fields.push(attachments);
    }

    const embed = createLogEmbed("Message Edited", 0x5865f2)
      .setURL(newMessage.url)
      .addFields(fields)
      .setFooter({ text: `Gods Bot • Message ID: ${newMessage.id}` });

    const author = newMessage.author ?? oldMessage.author;
    if (author) embed.setThumbnail(author.displayAvatarURL({ size: 256 }));

    await this.send(newMessage.guildId, "messages", embed);
  }

  async logVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    if (oldState.channelId === newState.channelId) return;

    const member = newState.member ?? oldState.member;
    const action = !oldState.channelId
      ? "Joined"
      : !newState.channelId
        ? "Left"
        : "Moved";
    const details: ActionDetail[] =
      action === "Moved"
        ? [
            {
              name: "Previous Channel",
              value: `<#${oldState.channelId}>`,
              inline: true,
            },
            {
              name: "New Channel",
              value: `<#${newState.channelId}>`,
              inline: true,
            },
          ]
        : [{
            name: "Voice Channel",
            value: `<#${newState.channelId ?? oldState.channelId}>`,
            inline: true,
          }];
    const embed = createLogEmbed(`Voice Channel ${action}`, 0x5865f2)
      .addFields(
        {
          name: "User",
          value: member ? `${member.user.tag}\n<@${newState.id}>` : `<@${newState.id}>`,
          inline: true,
        },
        ...details,
      )
      .setFooter({ text: `Gods Bot • User ID: ${newState.id}` });

    if (member) {
      embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
    }
    await this.send(newState.guild.id, "members", embed);
  }

  async logBulkDelete(messages: Collection<string, Message | PartialMessage>, channel: GuildChannel): Promise<void> {
    const embed = createLogEmbed("Bulk Message Delete", 0xed4245)
      .addFields(
        { name: "Channel", value: `<#${channel.id}>`, inline: true },
        { name: "Messages Deleted", value: messages.size.toString(), inline: true },
      )
      .setFooter({ text: `Gods Bot • Channel ID: ${channel.id}` });

    await this.send(channel.guildId, "messages", embed);
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  async logMemberJoin(member: GuildMember): Promise<void> {
    const accountAge = `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`;

    const embed = createLogEmbed("Member Joined", 0x57f287)
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "User", value: `${member.user.tag}\n<@${member.id}>`, inline: true },
        { name: "Account Created", value: accountAge, inline: true },
        { name: "Member Count", value: member.guild.memberCount.toString(), inline: true },
      )
      .setFooter({ text: `Gods Bot • User ID: ${member.id}` });

    await this.send(member.guild.id, "members", embed);
  }

  async logMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
    const roles = member.roles.cache
      .filter((r) => r.id !== member.guild.roles.everyone.id)
      .map((r) => `<@&${r.id}>`);

    const embed = createLogEmbed("Member Left", 0x99aab5)
      .setThumbnail(member.user?.displayAvatarURL({ size: 256 }) ?? null)
      .addFields(
        { name: "User", value: `${member.user?.tag ?? "Unknown"}\n<@${member.id}>`, inline: true },
        { name: "Roles", value: roles.length > 0 ? roles.join(", ") : "None", inline: false },
      )
      .setFooter({ text: `Gods Bot • User ID: ${member.id}` });

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
      const embed = createProfileCard("Name Changed", newMember.user, {
        name: "Display Name",
        value: `**Before:** ${oldNick ?? "*None*"}\n**After:** ${newNick ?? "*Removed*"}`,
        inline: false,
      });

      await this.send(guildId, "members", embed);
    }

    // ── Role changes — separate embeds for Added and Removed ──────────────
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    const added = newRoles.filter((r) => !oldRoles.has(r.id) && r.id !== everyoneId);
    const removed = oldRoles.filter((r) => !newRoles.has(r.id) && r.id !== everyoneId);

    if (added.size > 0) {
      const embed = createLogEmbed("Member Role Added", 0x57f287)
        .setThumbnail(newMember.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "User", value: `${newMember.user.tag}\n<@${newMember.id}>`, inline: true },
          {
            name: `Role${added.size > 1 ? "s" : ""} Added (${added.size})`,
            value: truncateField(
              added.map((role) => `<@&${role.id}> \`${role.name}\``).join("\n"),
            ),
            inline: false,
          },
        )
        .setFooter({ text: `Gods Bot • User ID: ${newMember.id}` });

      await this.send(guildId, "members", embed);
    }

    if (removed.size > 0) {
      const embed = createLogEmbed("Member Role Removed", 0xed4245)
        .setThumbnail(newMember.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "User", value: `${newMember.user.tag}\n<@${newMember.id}>`, inline: true },
          {
            name: `Role${removed.size > 1 ? "s" : ""} Removed (${removed.size})`,
            value: truncateField(
              removed.map((role) => `<@&${role.id}> \`${role.name}\``).join("\n"),
            ),
            inline: false,
          },
        )
        .setFooter({ text: `Gods Bot • User ID: ${newMember.id}` });

      await this.send(guildId, "members", embed);
    }
  }

  /**
   * Logs user-level profile changes (username, global display name, avatar).
   * Called from the UserUpdate event handler for every guild the user is in.
   */
  async logUserUpdate(guildId: string, oldUser: User, newUser: User): Promise<void> {
    const nameChanges: ActionDetail[] = [];
    if (oldUser.username !== newUser.username) {
      nameChanges.push({
        name: "Username",
        value: `**Before:** @${oldUser.username}\n**After:** @${newUser.username}`,
        inline: false,
      });
    }

    if (oldUser.globalName !== newUser.globalName) {
      nameChanges.push({
        name: "Display Name",
        value: `**Before:** ${oldUser.globalName ?? "*None*"}\n**After:** ${newUser.globalName ?? "*Removed*"}`,
        inline: false,
      });
    }

    if (nameChanges.length > 0) {
      await this.send(
        guildId,
        "members",
        createProfileCard("Name Changed", newUser, nameChanges),
      );
    }

    if (oldUser.avatar !== newUser.avatar) {
      const oldAvatarUrl = oldUser.displayAvatarURL({ size: 256 });
      const newAvatarUrl = newUser.displayAvatarURL({ size: 256 });
      await this.send(
        guildId,
        "members",
        createProfileCard(
          "Avatar Changed",
          newUser,
          {
            name: "Avatar Transition",
            value: `[Before](${oldAvatarUrl}) → [After](${newAvatarUrl})`,
          },
          oldAvatarUrl,
          newAvatarUrl,
        ),
      );
    }
  }

  // ─── Channels ──────────────────────────────────────────────────────────────

  async logChannelCreate(channel: Channel): Promise<void> {
    if (!channel.isTextBased() && !("name" in channel)) return;
    const gc = channel as GuildChannel;

    const embed = createLogEmbed("Channel Created", 0x57f287)
      .addFields(
        { name: "Name", value: `<#${gc.id}> \`${gc.name}\``, inline: true },
        { name: "Type", value: gc.type.toString(), inline: true },
      )
      .setFooter({ text: `Gods Bot • Channel ID: ${gc.id}` });

    await this.send(gc.guildId, "channels", embed);
  }

  async logChannelDelete(channel: Channel): Promise<void> {
    if (!("name" in channel)) return;
    const gc = channel as GuildChannel;

    const embed = createLogEmbed("Channel Deleted", 0xed4245)
      .addFields(
        { name: "Name", value: `\`${gc.name}\``, inline: true },
        { name: "Type", value: gc.type.toString(), inline: true },
      )
      .setFooter({ text: `Gods Bot • Channel ID: ${gc.id}` });

    await this.send(gc.guildId, "channels", embed);
  }

  async logChannelUpdate(oldChannel: Channel, newChannel: Channel): Promise<void> {
    if (!("name" in oldChannel) || !("name" in newChannel)) return;
    const oldGC = oldChannel as GuildChannel;
    const newGC = newChannel as GuildChannel;

    const changes: { name: string; value: string; inline: boolean }[] = [];

    if (oldGC.name !== newGC.name) {
      changes.push({
        name: "Name",
        value: `**Before:** \`${oldGC.name}\`\n**After:** \`${newGC.name}\``,
        inline: false,
      });
    }

    if ("topic" in oldGC && "topic" in newGC && oldGC.topic !== newGC.topic) {
      changes.push({
        name: "Topic",
        value: `**Before:** ${(oldGC as TextChannel).topic ?? "*None*"}\n**After:** ${(newGC as TextChannel).topic ?? "*None*"}`,
        inline: false,
      });
    }
    if (
      "rateLimitPerUser" in oldGC &&
      "rateLimitPerUser" in newGC &&
      oldGC.rateLimitPerUser !== newGC.rateLimitPerUser
    ) {
      changes.push({
        name: "Slowmode",
        value: `**Before:** ${oldGC.rateLimitPerUser}s\n**After:** ${newGC.rateLimitPerUser}s`,
        inline: true,
      });
    }
    if ("nsfw" in oldGC && "nsfw" in newGC && oldGC.nsfw !== newGC.nsfw) {
      changes.push({
        name: "NSFW",
        value: `**Before:** ${oldGC.nsfw ? "On" : "Off"}\n**After:** ${newGC.nsfw ? "On" : "Off"}`,
        inline: true,
      });
    }
    if (
      "bitrate" in oldGC &&
      "bitrate" in newGC &&
      oldGC.bitrate !== newGC.bitrate
    ) {
      changes.push({
        name: "Bitrate",
        value: `**Before:** ${oldGC.bitrate}\n**After:** ${newGC.bitrate}`,
        inline: true,
      });
    }
    if (
      "userLimit" in oldGC &&
      "userLimit" in newGC &&
      oldGC.userLimit !== newGC.userLimit
    ) {
      changes.push({
        name: "User Limit",
        value: `**Before:** ${oldGC.userLimit || "Unlimited"}\n**After:** ${newGC.userLimit || "Unlimited"}`,
        inline: true,
      });
    }

    if (changes.length === 0) return;

    const embed = createLogEmbed("Channel Updated", 0x5865f2)
      .addFields(
        { name: "Channel", value: `<#${newGC.id}>`, inline: true },
        ...changes.map((change) => ({
          ...change,
          value: truncateField(change.value),
        })),
      )
      .setFooter({ text: `Gods Bot • Channel ID: ${newGC.id}` });

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

    const embed = createLogEmbed("Role Created", role.color || 0x57f287)
      .addFields(
        { name: "Name", value: `<@&${role.id}> \`${role.name}\``, inline: true },
        { name: "Created By", value: creatorField, inline: true },
        { name: "Role ID", value: `\`${role.id}\``, inline: true },
        { name: "Color", value: role.hexColor, inline: true },
        { name: "Position", value: role.position.toString(), inline: true },
        { name: "Hoisted", value: role.hoist ? "Yes" : "No", inline: true },
        { name: "Mentionable", value: role.mentionable ? "Yes" : "No", inline: true },
        { name: `Permissions (${permCount})`, value: permList, inline: false },
      )
      .setFooter({ text: `Gods Bot • Role ID: ${role.id}` });

    await this.send(role.guild.id, "roles", embed);
  }

  async logRoleDelete(role: Role): Promise<void> {
    const embed = createLogEmbed("Role Deleted", 0xed4245)
      .addFields(
        { name: "Name", value: `\`${role.name}\``, inline: true },
        { name: "Color", value: role.hexColor, inline: true },
        { name: "Role ID", value: `\`${role.id}\``, inline: true },
      )
      .setFooter({ text: `Gods Bot • Role ID: ${role.id}` });

    await this.send(role.guild.id, "roles", embed);
  }

  async logRoleUpdate(oldRole: Role, newRole: Role): Promise<void> {
    const changes: { name: string; value: string; inline: boolean }[] = [];

    if (oldRole.name !== newRole.name) {
      changes.push({
        name: "Name",
        value: `**Before:** \`${oldRole.name}\`\n**After:** \`${newRole.name}\``,
        inline: false,
      });
    }
    if (oldRole.color !== newRole.color) {
      changes.push({
        name: "Color",
        value: `**Before:** ${oldRole.hexColor}\n**After:** ${newRole.hexColor}`,
        inline: true,
      });
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

    const embed = createLogEmbed("Role Updated", newRole.color || 0x5865f2)
      .addFields(
        { name: "Role", value: `<@&${newRole.id}>`, inline: true },
        { name: "Role ID", value: newRole.id, inline: true },
        ...changes.map((change) => ({
          ...change,
          value: truncateField(change.value),
        })),
      )
      .setFooter({ text: `Gods Bot • Role ID: ${newRole.id}` });

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
    const severity = await this.resolveSeverity(
      options.guildId,
      options.member.id,
      severityFromDetails(options.extra),
    );
    const details = [
      { name: "Security Module", value: options.module, inline: true },
      ...(options.extra ?? []).filter(
        (field) => !/severity|heat/i.test(field.name),
      ),
    ];
    const embed = createActionCard({
      title: "Security Action",
      targetId: options.member.id,
      targetLabel: options.member.user.tag,
      targetAvatarUrl: options.member.user.displayAvatarURL({ size: 256 }),
      action: options.action,
      reason: options.reason,
      severity,
      details,
    }).setFooter({
      text: `Gods Bot • User ID: ${options.member.id} • ${options.module}`,
    });

    await this.sendAction(
      options.guildId,
      "security",
      embed,
      options.member.id,
      options.action,
      "security",
    );
  }
}
