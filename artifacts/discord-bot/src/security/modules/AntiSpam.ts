import { Client, Events, GuildMember, Message } from "discord.js";
import { BaseSecurityModule } from "../BaseSecurityModule.js";
import type { SecurityManager } from "../SecurityManager.js";
import type { AntiSpamConfig } from "../types.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";

interface UserState {
  timestamps: number[];
  warnings: number;
}

export class AntiSpam extends BaseSecurityModule {
  private readonly tracker = new Map<string, Map<string, UserState>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(manager: SecurityManager) {
    super("antiSpam", manager);
  }

  get name() {
    return "Anti-Spam";
  }

  get description() {
    return "Detects message-rate spam and applies a configurable punishment.";
  }

  register(client: Client): void {
    client.on(Events.MessageCreate, (msg: Message) => {
      void this.onMessage(msg, client);
    });
    this.cleanupTimer = setInterval(() => this.prune(), 30_000);
    logger.info("AntiSpam: registered messageCreate handler");
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.tracker.clear();
    logger.info("AntiSpam: destroyed");
  }

  private async onMessage(message: Message, client: Client): Promise<void> {
    if (!message.inGuild() || message.author.bot) return;

    const { guildId, guild } = message;
    const cfg = this.manager.getConfig(guildId).antiSpam;
    if (!cfg.enabled) return;

    const member = message.member;
    if (!member) return;

    if (member.id === guild.ownerId) return;
    if (member.permissions.has("Administrator")) return;
    if (cfg.bypassUsers.includes(member.id)) return;
    if (cfg.bypassRoles.some((rid) => member.roles.cache.has(rid))) return;
    if (this.isExemptChannel(message.channelId, guildId)) return;

    const state = this.getOrCreate(guildId, member.id);
    const now = Date.now();
    state.timestamps.push(now);

    const recentCount = state.timestamps.filter(
      (t) => now - t < cfg.timeWindowMs
    ).length;

    if (recentCount < cfg.maxMessages) return;

    const windowSec = cfg.timeWindowMs / 1_000;
    const reason = `Spam detected: ${recentCount} messages in ${windowSec}s (limit: ${cfg.maxMessages})`;
    logger.info(
      `AntiSpam: TRIGGERED — ${member.user.tag} (${member.id}) sent ${recentCount} messages in ${windowSec}s — guild=${guildId} — action=${cfg.action}`
    );

    state.timestamps = [];

    await this.handleSpam(message, member, cfg, reason, client);
  }

  private async handleSpam(
    message: Message,
    member: GuildMember,
    cfg: AntiSpamConfig,
    reason: string,
    client: Client
  ): Promise<void> {
    const guildId = member.guild.id;
    const botId = client.user?.id ?? "system";

    await this.deleteMessage(message);
    logger.info(`AntiSpam: deleted message from ${member.user.tag}`);

    switch (cfg.action) {
      case "warn": {
        const state = this.getOrCreate(guildId, member.id);
        state.warnings += 1;

        const gjCfg = this.manager.getConfig(guildId).godsJudgment;
        const canEscalate = gjCfg.enabled && !!gjCfg.judgmentRoleId;

        if (state.warnings >= cfg.warnThreshold && canEscalate) {
          logger.info(
            `AntiSpam: warning threshold reached (${state.warnings}/${cfg.warnThreshold}) — escalating to God's Judgment`
          );
          const result = await this.manager.placeInJudgment(member, reason, botId);
          if (result.success) {
            state.warnings = 0;
            logger.info(`AntiSpam: escalated ${member.user.tag} to God's Judgment`);
          } else {
            logger.warn(`AntiSpam: escalation failed — ${result.reason}`);
          }
        } else {
          const warningMsg =
            state.warnings >= cfg.warnThreshold
              ? `⚠️ **Final Warning** in **${member.guild.name}**\n> ${reason}\n> Further violations may result in stronger action.`
              : `⚠️ **Warning ${state.warnings}/${cfg.warnThreshold}** in **${member.guild.name}**\n> ${reason}`;

          await member.send(warningMsg).catch(() =>
            logger.warn(`AntiSpam: could not DM ${member.user.tag}`)
          );
          logger.info(`AntiSpam: warned ${member.user.tag} (${state.warnings}/${cfg.warnThreshold})`);
        }
        break;
      }

      case "timeout": {
        try {
          await member.timeout(cfg.timeoutDurationMs, reason);
          const durationMin = Math.round(cfg.timeoutDurationMs / 60_000);
          logger.info(`AntiSpam: timed out ${member.user.tag} for ${durationMin} min`);
          await member
            .send(
              `⏱️ You have been **timed out** in **${member.guild.name}** for ${durationMin} minute(s).\n> **Reason:** ${reason}`
            )
            .catch(() => null);
        } catch (err) {
          logger.error(
            `AntiSpam: timeout failed for ${member.user.tag} — ${err instanceof Error ? err.message : String(err)}`
          );
        }
        break;
      }

      case "judgment": {
        const gjCfg = this.manager.getConfig(guildId).godsJudgment;
        if (!gjCfg.enabled || !gjCfg.judgmentRoleId) {
          logger.warn(
            `AntiSpam: action is "judgment" but God's Judgment is not set up in guild ${guildId}. Falling back to warn.`
          );
          await member
            .send(`⚠️ **Warning** in **${member.guild.name}**\n> ${reason}`)
            .catch(() => null);
          break;
        }
        const result = await this.manager.placeInJudgment(member, reason, botId);
        if (!result.success) {
          logger.warn(`AntiSpam: judgment failed — ${result.reason}`);
        } else {
          logger.info(`AntiSpam: placed ${member.user.tag} under God's Judgment`);
        }
        break;
      }

      default: {
        logger.warn(`AntiSpam: unknown action "${cfg.action as string}" — message deleted only`);
      }
    }

    const state = this.getOrCreate(guildId, member.id);
    await loggingService
      .logSecurityTrigger({
        guildId,
        module: "Anti-Spam",
        member,
        action: cfg.action,
        reason,
        extra: [
          {
            name: "Threshold",
            value: `${cfg.maxMessages} msg / ${cfg.timeWindowMs / 1_000}s`,
            inline: true,
          },
          ...(cfg.action === "warn"
            ? [{ name: "Warning Count", value: `${state.warnings}/${cfg.warnThreshold}`, inline: true }]
            : []),
          ...(cfg.action === "timeout"
            ? [{ name: "Timeout", value: `${Math.round(cfg.timeoutDurationMs / 60_000)} min`, inline: true }]
            : []),
        ],
      })
      .catch((err) =>
        logger.warn(`AntiSpam: failed to send security log — ${err instanceof Error ? err.message : err}`)
      );
  }

  private getOrCreate(guildId: string, userId: string): UserState {
    if (!this.tracker.has(guildId)) {
      this.tracker.set(guildId, new Map());
    }
    const gMap = this.tracker.get(guildId)!;
    if (!gMap.has(userId)) {
      gMap.set(userId, { timestamps: [], warnings: 0 });
    }
    return gMap.get(userId)!;
  }

  private prune(): void {
    const cutoff = Date.now() - 60_000;
    for (const [guildId, gMap] of this.tracker) {
      for (const [userId, state] of gMap) {
        state.timestamps = state.timestamps.filter((t) => t > cutoff);
        if (state.timestamps.length === 0 && state.warnings === 0) {
          gMap.delete(userId);
        }
      }
      if (gMap.size === 0) {
        this.tracker.delete(guildId);
      }
    }
  }

  getWarnings(guildId: string, userId: string): number {
    return this.tracker.get(guildId)?.get(userId)?.warnings ?? 0;
  }

  resetWarnings(guildId: string, userId: string): void {
    const state = this.tracker.get(guildId)?.get(userId);
    if (state) state.warnings = 0;
  }

  getTrackedUserCount(guildId: string): number {
    return this.tracker.get(guildId)?.size ?? 0;
  }
}
