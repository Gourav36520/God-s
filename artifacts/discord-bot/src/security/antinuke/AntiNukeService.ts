import { randomUUID } from "node:crypto";
import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
} from "discord.js";
import type {
  CategoryChannel,
  Client,
  Guild,
  GuildAuditLogsEntry,
  GuildMember,
  Role,
  TextChannel,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import type { SecurityManager } from "../SecurityManager.js";
import { createDefaultAntiNukeConfig, normalizeAntiNukeConfig } from "./defaults.js";
import {
  EventDeduplicator,
  resolveDefaultResponse,
  resolveJoinPolicy,
  resolveTrust,
  PunishmentGate,
  RollingThresholdCounter,
} from "./policy.js";
import type {
  AntiNukeConfig,
  AntiNukeDetector,
  AntiNukeIncident,
  AntiNukeResponse,
  IncidentFilters,
  LockdownSnapshot,
  TrustKind,
} from "./types.js";

type DatabaseApi = typeof import("@workspace/db");

const AUDIT_RETRY_DELAYS_MS = [0, 350, 750, 1_250] as const;
const AUDIT_MAX_AGE_MS = 10_000;
const EVENT_DEDUPE_TTL_MS = 60_000;

interface Activity {
  guild: Guild;
  detector: AntiNukeDetector;
  targetId: string | null;
  executorId: string | null;
  eventKey: string | null;
  action: string;
  details: Record<string, unknown>;
  occurredAt: Date;
}

export class AntiNukeService {
  private client: Client | null = null;
  private database: DatabaseApi | null = null;
  private readonly configs = new Map<string, AntiNukeConfig>();
  private readonly counter = new RollingThresholdCounter();
  private readonly eventDeduplicator = new EventDeduplicator(EVENT_DEDUPE_TTL_MS);
  private readonly punishmentGate = new PunishmentGate();
  private readonly activeLockdowns = new Set<string>();

  constructor(private readonly security: SecurityManager) {}

  async init(client: Client): Promise<void> {
    this.client = client;
    this.database = await import("@workspace/db");
    const rows = await this.database.loadAntiNukeConfigRows();
    for (const row of rows) {
      this.configs.set(row.guildId, normalizeAntiNukeConfig(row.config));
    }
    logger.info(
      `AntiNukeService: loaded ${rows.length} guild configuration(s) from PostgreSQL`,
    );
  }

  register(client: Client): void {
    client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
      void this.handleAuditEntry(entry, guild).catch((error: unknown) =>
        logger.error("AntiNuke: audit event handler failed", error),
      );
    });
    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      const oldRoles = oldMember.roles.cache;
      const newRoles = newMember.roles.cache;
      if (oldRoles.size === newRoles.size && oldRoles.every((role) => newRoles.has(role.id))) {
        return;
      }
      void this.handleMemberRoleUpdate(newMember, oldRoles, newRoles).catch(
        (error: unknown) => logger.error("AntiNuke: member role update failed", error),
      );
    });
  }

  getConfig(guildId: string): AntiNukeConfig {
    this.assertReady();
    let config = this.configs.get(guildId);
    if (!config) {
      config = createDefaultAntiNukeConfig();
      this.configs.set(guildId, config);
      logger.info(
        `AntiNukeService: initialized default configuration for guild ${guildId}`,
      );
    }
    return config;
  }

  async updateConfig(
    guildId: string,
    updater: (current: AntiNukeConfig) => AntiNukeConfig,
  ): Promise<AntiNukeConfig> {
    this.assertReady();
    const next = normalizeAntiNukeConfig(
      updater(structuredClone(this.getConfig(guildId))),
    );
    this.configs.set(guildId, next);
    await this.database!.saveAntiNukeConfigRow(
      guildId,
      next as unknown as Record<string, unknown>,
    );
    return next;
  }

  async resetConfig(guildId: string): Promise<AntiNukeConfig> {
    this.assertReady();
    const next = createDefaultAntiNukeConfig();
    next.judgementRoleId =
      this.security.getConfig(guildId).godsJudgment.judgmentRoleId;
    this.configs.set(guildId, next);
    await this.database!.saveAntiNukeConfigRow(
      guildId,
      next as unknown as Record<string, unknown>,
    );
    return next;
  }

  async getIncident(guildId: string, id: string): Promise<AntiNukeIncident | null> {
    this.assertReady();
    const row = await this.database!.findAntiNukeIncidentRow(guildId, id);
    return row ? (row as AntiNukeIncident) : null;
  }

  async listIncidents(
    guildId: string,
    filters: IncidentFilters = {},
    limit = 10,
  ): Promise<AntiNukeIncident[]> {
    this.assertReady();
    return (await this.database!.listAntiNukeIncidentRows(
      guildId,
      filters,
      limit,
    )) as AntiNukeIncident[];
  }

  async recordSystemIncident(options: {
    guild?: Guild;
    guildId?: string;
    action: string;
    executorId?: string | null;
    targetId?: string | null;
    response?: string;
    outcome: string;
    details?: Record<string, unknown>;
    eventKey?: string | null;
  }): Promise<AntiNukeIncident | null> {
    const guildId = options.guild?.id ?? options.guildId;
    if (!guildId) {
      throw new Error("Anti-Nuke system incidents require a guild ID.");
    }
    const incident: AntiNukeIncident = {
      id: randomUUID(),
      guildId,
      eventKey: options.eventKey ?? null,
      detector: "system",
      executorId: options.executorId ?? null,
      targetId: options.targetId ?? null,
      action: options.action,
      thresholdCount: 0,
      response: options.response ?? "log",
      outcome: options.outcome,
      details: options.details ?? {},
      occurredAt: new Date(),
    };
    return this.persistIncident(incident, options.guild);
  }

  async handleMemberJoin(member: GuildMember): Promise<boolean> {
    const config = this.getConfig(member.guild.id);
    const trust = resolveTrust(config, member.id);
    const isBot = member.user.bot;
    const joinResponse = resolveJoinPolicy(config, member.id, isBot);
    const kickBot = isBot && joinResponse === "kick";
    const humanMode = !isBot && trust === "blacklisted" ? joinResponse : null;

    let response: string = "log";
    const shouldStopJoinSideEffects =
      kickBot || (humanMode !== null && humanMode !== "log");
    let outcome = isBot
      ? trust === "blacklisted"
        ? "Blacklisted bot joined; kick required."
        : trust === "whitelisted"
          ? "Approved bot joined."
          : "Unapproved bot joined; automatic kick is disabled."
      : trust === "blacklisted"
        ? `Blacklisted human joined; configured response is ${humanMode}.`
        : "";

    if (kickBot) {
      response = "kick";
      outcome = config.dryRun
        ? "DRY RUN: would kick the blacklisted or unapproved bot."
        : await this.kickMember(member, "Anti-Nuke bot admission policy");
    } else if (humanMode && humanMode !== "log") {
      response = humanMode;
      outcome = config.dryRun
        ? `DRY RUN: would apply ${humanMode} to the blacklisted member.`
        : await this.applyMemberResponse(
            member,
            humanMode,
            "Anti-Nuke blacklisted member join",
          );
    }

    // The kick is attempted before audit-log retries so a blacklisted bot is
    // handled promptly. The executor may remain unknown if Discord delays logs.
    let auditEntry: GuildAuditLogsEntry | null = null;
    if (isBot) {
      auditEntry = await this.findAuditEntry(
        member.guild,
        AuditLogEvent.BotAdd,
        member.id,
      );
      if (auditEntry) await this.handleAuditEntry(auditEntry, member.guild);
    }

    if (isBot || trust === "blacklisted") {
      await this.recordSystemIncident({
        guild: member.guild,
        action: isBot ? "bot-join-policy" : "blacklisted-human-join",
        executorId: auditEntry?.executorId ?? null,
        targetId: member.id,
        response,
        outcome,
        eventKey: auditEntry
          ? `${auditEntry.id}:join-policy`
          : `join:${member.guild.id}:${member.id}:${member.joinedTimestamp ?? Date.now()}`,
        details: {
          identityConfirmed: true,
          bot: isBot,
          trust,
          unverifiedBotKickEnabled: config.unverifiedBotKick,
          blacklistedHumanJoinResponse: humanMode,
        },
      });
    }
    return shouldStopJoinSideEffects;
  }

  async setupLogs(guild: Guild): Promise<{
    success: boolean;
    categoryId?: string;
    channelId?: string;
    message: string;
  }> {
    const botMember = guild.members.me;
    if (
      !botMember ||
      !botMember.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles)
    ) {
      return {
        success: false,
        message: "The bot needs Manage Channels and Manage Roles to create private Anti-Nuke Logs.",
      };
    }

    const channels = await guild.channels.fetch();
    let category = channels.find(
      (channel) =>
        channel?.type === ChannelType.GuildCategory &&
        channel.name === "Anti-Nuke Logs",
    ) as CategoryChannel | undefined;

    if (!category) {
      category = await guild.channels.create({
        name: "Anti-Nuke Logs",
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: botMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
        reason: "Set up dedicated Anti-Nuke staff logs",
      });
    } else {
      await category.permissionOverwrites.edit(
        guild.roles.everyone,
        { ViewChannel: false },
        { reason: "Keep Anti-Nuke staff logs private" },
      );
      await category.permissionOverwrites.edit(
        botMember.id,
        {
          ViewChannel: true,
          SendMessages: true,
          EmbedLinks: true,
          ReadMessageHistory: true,
        },
        { reason: "Allow the bot to post Anti-Nuke staff logs" },
      );
    }

    await this.updateConfig(guild.id, (current) => ({
      ...current,
      logs: { ...current.logs, categoryId: category!.id },
    }));

    let logChannel = channels.find(
      (channel) =>
        channel?.type === ChannelType.GuildText &&
        channel.name === "antinuke-logs",
    ) as TextChannel | undefined;
    if (!logChannel) {
      logChannel = await guild.channels.create({
        name: "antinuke-logs",
        type: ChannelType.GuildText,
        parent: category.id,
        topic: "Private security events and Anti-Nuke incident records.",
        reason: "Set up dedicated Anti-Nuke log channel",
      });
    } else if (logChannel.parentId !== category.id) {
      await logChannel.setParent(category.id, {
        lockPermissions: false,
        reason: "Move Anti-Nuke logs into their dedicated category",
      });
    }
    await logChannel.permissionOverwrites.edit(
      guild.roles.everyone,
      { ViewChannel: false },
      { reason: "Keep Anti-Nuke staff logs private" },
    );
    await logChannel.permissionOverwrites.edit(
      botMember.id,
      {
        ViewChannel: true,
        SendMessages: true,
        EmbedLinks: true,
        ReadMessageHistory: true,
      },
      { reason: "Allow the bot to post Anti-Nuke staff logs" },
    );

    await this.updateConfig(guild.id, (current) => ({
      ...current,
      logs: {
        ...current.logs,
        categoryId: category!.id,
        channelId: logChannel!.id,
      },
    }));

    const permissions = logChannel.permissionsFor(botMember);
    if (
      !permissions.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.SendMessages) ||
      !permissions.has(PermissionFlagsBits.EmbedLinks)
    ) {
      return {
        success: false,
        categoryId: category.id,
        channelId: logChannel.id,
        message: "The resources exist, but the bot cannot send embeds in the log channel.",
      };
    }
    return {
      success: true,
      categoryId: category.id,
      channelId: logChannel.id,
      message: "Anti-Nuke Logs is ready; existing resources were reused.",
    };
  }

  async applyLockdown(guild: Guild): Promise<{
    changed: number;
    skipped: number;
    message: string;
  }> {
    const config = this.getConfig(guild.id);
    if (!config.lockdown.enabled) {
      return { changed: 0, skipped: 0, message: "Automatic lockdown is disabled." };
    }
    if (config.lockdown.targets.length === 0) {
      return {
        changed: 0,
        skipped: 0,
        message: "No lockdown targets are configured; no channels were changed.",
      };
    }
    if (this.activeLockdowns.has(guild.id)) {
      return { changed: 0, skipped: 0, message: "A lockdown operation is already running." };
    }
    this.activeLockdowns.add(guild.id);

    try {
      const botMember = guild.members.me;
      if (
        !botMember ||
        !botMember.permissions.has(PermissionFlagsBits.ManageChannels) ||
        !botMember.permissions.has(PermissionFlagsBits.ManageRoles)
      ) {
        return {
          changed: 0,
          skipped: config.lockdown.targets.length,
          message: "The bot lacks Manage Channels or Manage Roles; no lockdown changes were made.",
        };
      }

      let changed = 0;
      let skipped = 0;
      for (const channelId of config.lockdown.targets) {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !("permissionOverwrites" in channel)) {
          skipped += 1;
          continue;
        }
        if (config.lockdown.snapshots.some((item) => item.channelId === channelId)) {
          skipped += 1;
          continue;
        }
        const everyone = guild.roles.everyone;
        const previous = channel.permissionOverwrites.cache.get(everyone.id);
        try {
          await channel.permissionOverwrites.edit(
            everyone,
            { SendMessages: false },
            { reason: "Configured Anti-Nuke lockdown" },
          );
          const applied = channel.permissionOverwrites.cache.get(everyone.id);
          if (!applied) {
            skipped += 1;
            continue;
          }
          const snapshot: LockdownSnapshot = {
            channelId,
            hadOverwrite: Boolean(previous),
            previousAllow: previous?.allow.bitfield.toString() ?? "0",
            previousDeny: previous?.deny.bitfield.toString() ?? "0",
            appliedAllow: applied.allow.bitfield.toString(),
            appliedDeny: applied.deny.bitfield.toString(),
            changedAt: new Date().toISOString(),
          };
          await this.updateConfig(guild.id, (current) => ({
            ...current,
            lockdown: {
              ...current.lockdown,
              snapshots: [
                ...current.lockdown.snapshots.filter(
                  (item) => item.channelId !== channelId,
                ),
                snapshot,
              ],
            },
          }));
          changed += 1;
        } catch (error) {
          skipped += 1;
          logger.warn(`AntiNuke: lockdown failed for channel ${channelId}`, error);
        }
      }
      return {
        changed,
        skipped,
        message: `Lockdown changed ${changed} configured channel(s); ${skipped} were skipped or failed.`,
      };
    } finally {
      this.activeLockdowns.delete(guild.id);
    }
  }

  async restoreLockdown(guild: Guild): Promise<{
    restored: number;
    skipped: number;
    message: string;
  }> {
    const config = this.getConfig(guild.id);
    const botMember = guild.members.me;
    if (
      !botMember ||
      !botMember.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !botMember.permissions.has(PermissionFlagsBits.ManageRoles)
    ) {
      return {
        restored: 0,
        skipped: config.lockdown.snapshots.length,
        message: "The bot lacks Manage Channels or Manage Roles; lockdown was not restored.",
      };
    }

    let restored = 0;
    let skipped = 0;
    const remaining: LockdownSnapshot[] = [];
    for (const snapshot of config.lockdown.snapshots) {
      const channel = await guild.channels.fetch(snapshot.channelId).catch(() => null);
      if (!channel || !("permissionOverwrites" in channel)) {
        skipped += 1;
        remaining.push(snapshot);
        continue;
      }
      const current = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      if (
        current?.allow.bitfield.toString() !== snapshot.appliedAllow ||
        current?.deny.bitfield.toString() !== snapshot.appliedDeny
      ) {
        skipped += 1;
        remaining.push(snapshot);
        continue;
      }
      try {
        if (snapshot.hadOverwrite) {
          const sendMessagesBit = BigInt(PermissionFlagsBits.SendMessages);
          const previousAllow = (BigInt(snapshot.previousAllow) & sendMessagesBit) !== 0n;
          const previousDeny = (BigInt(snapshot.previousDeny) & sendMessagesBit) !== 0n;
          await channel.permissionOverwrites.edit(
            guild.roles.everyone,
            { SendMessages: previousAllow ? true : previousDeny ? false : null },
            { reason: "Restore configured Anti-Nuke lockdown state" },
          );
        } else {
          await channel.permissionOverwrites.delete(
            guild.roles.everyone,
            "Restore configured Anti-Nuke lockdown state",
          );
        }
        restored += 1;
      } catch (error) {
        skipped += 1;
        remaining.push(snapshot);
        logger.warn(`AntiNuke: lockdown restore failed for ${snapshot.channelId}`, error);
      }
    }

    await this.updateConfig(guild.id, (current) => ({
      ...current,
      lockdown: { ...current.lockdown, snapshots: remaining },
    }));
    return {
      restored,
      skipped,
      message: `Restored ${restored} configured channel(s); skipped ${skipped} changed or unavailable channel(s). Skipped snapshots remain for review.`,
    };
  }

  private async handleAuditEntry(
    entry: GuildAuditLogsEntry,
    guild: Guild,
  ): Promise<void> {
    for (const detector of mapAuditDetectors(entry)) {
      await this.processActivity({
        guild,
        detector,
        targetId: entry.targetId,
        executorId: entry.executorId,
        eventKey: `${entry.id}:${detector}`,
        action: detector,
        details: {
          auditEntryId: entry.id,
          auditAction: String(entry.action),
          changes: formatAuditChanges(entry),
        },
        occurredAt: new Date(entry.createdTimestamp),
      });
    }
  }

  private async handleMemberRoleUpdate(
    member: GuildMember,
    oldRoles: ReadonlyMap<string, Role>,
    newRoles: ReadonlyMap<string, Role>,
  ): Promise<void> {
    const addedIds = [...newRoles.keys()].filter((id) => !oldRoles.has(id)).sort();
    const removedIds = [...oldRoles.keys()].filter((id) => !newRoles.has(id)).sort();
    if (addedIds.length === 0 && removedIds.length === 0) return;

    const entry = await this.findAuditEntry(
      member.guild,
      AuditLogEvent.MemberRoleUpdate,
      member.id,
    );
    if (entry) {
      await this.handleAuditEntry(entry, member.guild);
      return;
    }
    await this.recordSystemIncident({
      guild: member.guild,
      action: "member-role-change",
      targetId: member.id,
      outcome: "Audit executor unavailable after bounded lookup; no automatic punishment.",
      eventKey: `member-role-change:${member.guild.id}:${member.id}:${addedIds.join(",")}:${removedIds.join(",")}`,
      details: { executorUnknown: true, addedRoleIds: addedIds, removedRoleIds: removedIds },
    });
  }

  private async findAuditEntry(
    guild: Guild,
    action: AuditLogEvent,
    targetId: string,
  ): Promise<GuildAuditLogsEntry | null> {
    for (const delay of AUDIT_RETRY_DELAYS_MS) {
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      const logs = await guild.fetchAuditLogs({ type: action, limit: 5 }).catch(() => null);
      if (!logs) continue;
      const now = Date.now();
      const match = logs.entries.find(
        (candidate) =>
          candidate.targetId === targetId &&
          Math.abs(now - candidate.createdTimestamp) <= AUDIT_MAX_AGE_MS,
      );
      if (match) return match;
    }
    return null;
  }

  private async processActivity(activity: Activity): Promise<void> {
    const config = this.getConfig(activity.guild.id);
    const setting = config.detectors[activity.detector];
    if (activity.eventKey && !this.claimEvent(activity.eventKey)) return;
    const now = activity.occurredAt.getTime();
    const trust = activity.executorId
      ? await this.resolveExecutorKind(activity.guild, activity.executorId, config)
      : "unknown";

    let count = 0;
    let thresholdReached = false;
    let response: AntiNukeResponse = "log";
    let shouldRespond = false;
    let duplicateResponse = false;

    if (activity.executorId && config.enabled && setting.enabled) {
      count = this.counter.add(
        activity.guild.id,
        activity.executorId,
        activity.detector,
        now,
        setting.windowSeconds * 1_000,
      );
      thresholdReached = count >= setting.limit;
      const trustStatus = activity.executorId
        ? resolveTrust(config, activity.executorId)
        : "unapproved";
      if (
        thresholdReached &&
        trust !== "unknown" &&
        trustStatus !== "whitelisted"
      ) {
        response = resolveDefaultResponse(activity.detector, trust, setting.responseMode);
        const key = JSON.stringify([
          activity.guild.id,
          activity.executorId,
          activity.detector,
        ]);
        shouldRespond = this.punishmentGate.claim(
          key,
          Date.now(),
          setting.windowSeconds * 1_000,
        );
        duplicateResponse = !shouldRespond;
      }
    }

    const incident: AntiNukeIncident = {
      id: randomUUID(),
      guildId: activity.guild.id,
      eventKey: activity.eventKey,
      detector: activity.detector,
      executorId: activity.executorId,
      targetId: activity.targetId,
      action: activity.action,
      thresholdCount: count,
      response,
      outcome: "processing",
      details: {
        ...activity.details,
        executorKind: trust,
        thresholdReached,
        limit: setting.limit,
        windowSeconds: setting.windowSeconds,
        detectorEnabled: setting.enabled,
      },
      occurredAt: activity.occurredAt,
    };

    let inserted: boolean;
    try {
      inserted = await this.database!.createAntiNukeIncidentRow(
        incident as unknown as Parameters<
          DatabaseApi["createAntiNukeIncidentRow"]
        >[0],
      );
    } catch (error) {
      logger.error("AntiNuke: incident persistence failed; response skipped", error);
      return;
    }
    if (!inserted) return;

    let outcome: string;
    if (!activity.executorId || trust === "unknown") {
      outcome = "Unknown or ambiguous executor identity/type; event logged and no automatic punishment attempted.";
    } else if (!setting.enabled) {
      outcome = "Detector disabled; event logged without a response.";
    } else if (!config.enabled) {
      outcome = "Anti-Nuke disabled; event logged without a response.";
    } else if (!thresholdReached) {
      outcome = `Threshold not reached (${count}/${setting.limit}).`;
    } else if (resolveTrust(config, activity.executorId) === "whitelisted") {
      outcome = "Threshold reached; whitelisted executor was not automatically punished.";
    } else if (duplicateResponse) {
      outcome = "Threshold reached; duplicate punishment suppressed for this rolling window.";
    } else if (!shouldRespond) {
      outcome = "Threshold reached; no response was scheduled.";
    } else if (config.dryRun) {
      outcome = `DRY RUN: would apply ${response} to executor ${activity.executorId}.`;
    } else {
      outcome = await this.applyResponse(
        activity.guild,
        activity.executorId,
        response,
        `Anti-Nuke ${activity.detector}: ${count}/${setting.limit} events in ${setting.windowSeconds}s`,
      );
    }

    incident.outcome = outcome;
    await this.database!
      .updateAntiNukeIncidentOutcome(
        incident.guildId,
        incident.id,
        outcome,
        incident.details,
      )
      .catch((error: unknown) =>
        logger.error(`AntiNuke: could not update incident ${incident.id}`, error),
      );
    await this.sendIncident(activity.guild, incident, thresholdReached);
    logger.warn(
      `AntiNuke detector=${activity.detector} guild=${activity.guild.id} executor=${activity.executorId ?? "unknown"} target=${activity.targetId ?? "unknown"} count=${count}/${setting.limit} response=${response} outcome=${outcome}`,
    );
  }

  private async resolveExecutorKind(
    guild: Guild,
    id: string,
    config: AntiNukeConfig,
  ): Promise<TrustKind> {
    const trust = resolveTrust(config, id);
    const entry =
      trust === "blacklisted"
        ? config.blacklist[id]
        : trust === "whitelisted"
          ? config.whitelist[id]
          : null;
    if (entry && entry.kind !== "unknown") return entry.kind;
    const user = await guild.client.users.fetch(id).catch(() => null);
    return user ? (user.bot ? "bot" : "human") : "unknown";
  }

  private async applyResponse(
    guild: Guild,
    executorId: string,
    response: AntiNukeResponse,
    reason: string,
  ): Promise<string> {
    if (executorId === guild.ownerId) {
      return "Server owner protected; no automatic action attempted.";
    }
    if (response === "log") return "Logged only; response policy is log.";
    if (response === "lockdown") return (await this.applyLockdown(guild)).message;
    const member = await guild.members.fetch(executorId).catch(() => null);
    if (!member) return `Executor ${executorId} is unavailable; ${response} was not attempted.`;
    return response === "kick"
      ? this.kickMember(member, reason)
      : this.applyMemberResponse(member, "judgement", reason);
  }

  private async applyMemberResponse(
    member: GuildMember,
    response: "judgement" | "kick",
    reason: string,
  ): Promise<string> {
    if (member.id === member.guild.ownerId) {
      return "Server owner protected; no action attempted.";
    }
    if (response === "kick") return this.kickMember(member, reason);
    const result = await this.security.placeInJudgment(
      member,
      reason,
      this.client?.user?.id ?? "anti-nuke",
    );
    if (!result.success) return `God's Judgment failed: ${result.reason}`;
    return result.partial
      ? `God's Judgment role assigned with partial failures: ${result.reason}`
      : "God's Judgment applied successfully.";
  }

  private async kickMember(member: GuildMember, reason: string): Promise<string> {
    const botMember = member.guild.members.me;
    if (
      !botMember?.permissions.has(PermissionFlagsBits.KickMembers) ||
      !member.kickable
    ) {
      return "Kick failed: missing Kick Members permission or target is above bot hierarchy.";
    }
    try {
      await member.kick(reason);
      return `Kick succeeded for ${member.id}.`;
    } catch (error) {
      return `Kick failed for ${member.id}: ${shortError(error)}`;
    }
  }

  private async persistIncident(
    incident: AntiNukeIncident,
    guild?: Guild,
  ): Promise<AntiNukeIncident | null> {
    this.assertReady();
    if (incident.eventKey && !this.claimEvent(incident.eventKey)) return null;
    try {
      const inserted = await this.database!.createAntiNukeIncidentRow(
        incident as unknown as Parameters<
          DatabaseApi["createAntiNukeIncidentRow"]
        >[0],
      );
      if (!inserted) return null;
    } catch (error) {
      logger.error("AntiNuke: system incident persistence failed", error);
      return null;
    }
    const logSent = guild
      ? await this.sendIncident(guild, incident, false)
      : false;
    if (!guild) {
      logger.warn(
        `AntiNuke: saved incident for guild ${incident.guildId}; Discord log delivery skipped because guild resources were unavailable.`,
      );
    }
    if (incident.action === "logs-test") {
      incident.details = { ...incident.details, logSent };
      await this.database!
        .updateAntiNukeIncidentOutcome(
          incident.guildId,
          incident.id,
          incident.outcome,
          incident.details,
        )
        .catch((error: unknown) =>
          logger.error(`AntiNuke: could not store log-test delivery result ${incident.id}`, error),
        );
    }
    return incident;
  }

  private async sendIncident(
    guild: Guild,
    incident: AntiNukeIncident,
    thresholdReached: boolean,
  ): Promise<boolean> {
    const config = this.getConfig(guild.id);
    if (!config.logs.alertsEnabled || !config.logs.channelId || !this.client) return false;

    const channel = await this.client.channels
      .fetch(config.logs.channelId)
      .catch(() => null);
    const botMember = guild.members.me;
    if (
      !channel?.isTextBased() ||
      !("permissionsFor" in channel) ||
      !botMember
    ) {
      logger.warn(`AntiNuke: log channel ${config.logs.channelId} is unavailable.`);
      return false;
    }
    const permissions = channel.permissionsFor(botMember);
    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.SendMessages) ||
      !permissions.has(PermissionFlagsBits.EmbedLinks)
    ) {
      logger.warn(`AntiNuke: bot cannot post to log channel ${config.logs.channelId}.`);
      return false;
    }

    const embed = new EmbedBuilder()
      .setTitle(`Anti-Nuke · ${incident.detector}`)
      .setColor(thresholdReached ? 0xed4245 : 0xfaa61a)
      .setDescription(`**Action:** ${incident.action}\n**Outcome:** ${incident.outcome}`)
      .addFields(
        {
          name: "Executor",
          value: incident.executorId
            ? `ID \`${incident.executorId}\` · type ${
                typeof incident.details.executorKind === "string"
                  ? incident.details.executorKind
                  : "unknown"
              }`
            : "Unknown executor; audit log did not identify one.",
          inline: true,
        },
        {
          name: "Target",
          value: incident.targetId ? `ID \`${incident.targetId}\`` : "Unknown target",
          inline: true,
        },
        {
          name: "Threshold",
          value:
            typeof incident.details.limit === "number" &&
            typeof incident.details.windowSeconds === "number"
              ? `${incident.thresholdCount}/${incident.details.limit} in ${incident.details.windowSeconds}s`
              : `${incident.thresholdCount} event(s)`,
          inline: true,
        },
        { name: "Response", value: incident.response, inline: true },
        { name: "Incident ID", value: `\`${incident.id}\``, inline: true },
        {
          name: "Details",
          value: truncate(JSON.stringify(incident.details), 900),
          inline: false,
        },
      )
      .setTimestamp(incident.occurredAt);

    const content =
      config.logs.mentionOwner && thresholdReached
        ? `<@${guild.ownerId}>`
        : undefined;
    try {
      await channel.send({
        content,
        embeds: [embed],
        allowedMentions: content
          ? { users: [guild.ownerId], parse: [] }
          : { parse: [] },
      });
      return true;
    } catch (error) {
      logger.warn(`AntiNuke: failed to send incident ${incident.id}`, error);
      return false;
    }
  }

  private claimEvent(key: string): boolean {
    return this.eventDeduplicator.claim(key);
  }

  private assertReady(): void {
    if (!this.database || !this.client) {
      throw new Error("AntiNukeService is not initialized.");
    }
  }
}

function mapAuditDetectors(entry: GuildAuditLogsEntry): AntiNukeDetector[] {
  switch (entry.action) {
    case AuditLogEvent.ChannelCreate:
      return ["channel-create"];
    case AuditLogEvent.ChannelDelete:
      return ["channel-delete"];
    case AuditLogEvent.ChannelUpdate:
      return ["channel-update"];
    case AuditLogEvent.MemberKick:
      return ["member-kick"];
    case AuditLogEvent.MemberBanAdd:
      return ["member-ban"];
    case AuditLogEvent.RoleCreate:
      return ["role-create"];
    case AuditLogEvent.RoleDelete:
      return ["role-delete"];
    case AuditLogEvent.RoleUpdate:
      return [permissionGrantDetected(entry) ? "role-permissions" : "role-update"];
    case AuditLogEvent.MemberRoleUpdate: {
      const keys = new Set((entry.changes ?? []).map((change) => change.key));
      return [
        ...(keys.has("$add") ? ["mass-role-add" as const] : []),
        ...(keys.has("$remove") ? ["mass-role-remove" as const] : []),
      ];
    }
    case AuditLogEvent.WebhookCreate:
      return ["webhook-create"];
    case AuditLogEvent.WebhookDelete:
      return ["webhook-delete"];
    case AuditLogEvent.WebhookUpdate:
      return ["webhook-update"];
    case AuditLogEvent.IntegrationCreate:
    case AuditLogEvent.IntegrationUpdate:
    case AuditLogEvent.IntegrationDelete:
      return ["integration-change"];
    case AuditLogEvent.GuildUpdate:
      return ["guild-update"];
    case AuditLogEvent.EmojiCreate:
    case AuditLogEvent.EmojiDelete:
    case AuditLogEvent.EmojiUpdate:
    case AuditLogEvent.StickerCreate:
    case AuditLogEvent.StickerDelete:
    case AuditLogEvent.StickerUpdate:
      return ["emoji-sticker-change"];
    case AuditLogEvent.InviteCreate:
      return ["invite-create"];
    case AuditLogEvent.InviteDelete:
      return ["invite-delete"];
    default:
      return [];
  }
}

function permissionGrantDetected(entry: GuildAuditLogsEntry): boolean {
  const change = entry.changes?.find((item) => item.key === "permissions");
  if (!change) return false;
  const before = permissionNames(change.old);
  const after = permissionNames(change.new);
  const dangerous = [
    "ADMINISTRATOR",
    "MANAGE_GUILD",
    "MANAGE_ROLES",
    "MANAGE_CHANNELS",
    "KICK_MEMBERS",
    "BAN_MEMBERS",
    "MANAGE_WEBHOOKS",
    "MANAGE_EMOJIS_AND_STICKERS",
    "MANAGE_EVENTS",
  ];
  return dangerous.some((name) => after.has(name) && !before.has(name));
}

function permissionNames(value: unknown): Set<string> {
  if (Array.isArray(value)) {
    return new Set(value.filter((part): part is string => typeof part === "string"));
  }
  if (typeof value === "string") {
    return new Set(
      value.split(/[\s,|]+/u).filter(Boolean).map((part) => part.toUpperCase()),
    );
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const bits = BigInt(value);
    const flags: Record<string, bigint> = {
      ADMINISTRATOR: PermissionFlagsBits.Administrator,
      MANAGE_GUILD: PermissionFlagsBits.ManageGuild,
      MANAGE_ROLES: PermissionFlagsBits.ManageRoles,
      MANAGE_CHANNELS: PermissionFlagsBits.ManageChannels,
      KICK_MEMBERS: PermissionFlagsBits.KickMembers,
      BAN_MEMBERS: PermissionFlagsBits.BanMembers,
      MANAGE_WEBHOOKS: PermissionFlagsBits.ManageWebhooks,
      MANAGE_EMOJIS_AND_STICKERS: PermissionFlagsBits.ManageEmojisAndStickers,
      MANAGE_EVENTS: PermissionFlagsBits.ManageEvents,
    };
    return new Set(
      Object.entries(flags)
        .filter(([, flag]) => (bits & flag) !== 0n)
        .map(([name]) => name),
    );
  }
  return new Set();
}

function formatAuditChanges(entry: GuildAuditLogsEntry): string[] {
  return (entry.changes ?? []).slice(0, 8).map((change) => {
    const oldValue =
      change.old === undefined ? "" : ` ${truncate(String(change.old), 100)} →`;
    const newValue =
      change.new === undefined ? "" : ` ${truncate(String(change.new), 100)}`;
    return `${change.key}:${oldValue}${newValue}`.slice(0, 250);
  });
}

function shortError(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), 300);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
