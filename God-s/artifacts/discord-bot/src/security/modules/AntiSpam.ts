import { Client, Events, GuildMember, Message } from "discord.js";
import { BaseSecurityModule } from "../BaseSecurityModule.js";
import type { SecurityManager } from "../SecurityManager.js";
import type { AntiSpamAction, AntiSpamConfig } from "../types.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";

const VIOLATION_RESET_MS = 24 * 60 * 60 * 1_000;
const HEAT_PER_VIOLATION = 5;

const PUNISHMENT_TABLE: Record<number, { action: AntiSpamAction; timeoutDurationMs?: number }> = {
  1: { action: "warn" },
  2: { action: "warn" },
  3: { action: "timeout", timeoutDurationMs: 10 * 60 * 1_000 },
  4: { action: "timeout", timeoutDurationMs: 10 * 60 * 1_000 },
  5: { action: "timeout", timeoutDurationMs: 30 * 60 * 1_000 },
  6: { action: "timeout", timeoutDurationMs: 30 * 60 * 1_000 },
  7: { action: "timeout", timeoutDurationMs: 60 * 60 * 1_000 },
  8: { action: "timeout", timeoutDurationMs: 60 * 60 * 1_000 },
  9: { action: "timeout", timeoutDurationMs: 6 * 60 * 60 * 1_000 },
  10: { action: "judgment" },
};

interface UserState {
  timestamps: number[];
  violationCount: number;
  violationWindowStartedAt: number | null;
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
    if (this.manager.isAntiSpamExempt(member)) {
      this.clearUserState(guildId, member.id);
      return;
    }
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
    const violationCount = this.recordViolation(guildId, member.id, now);
    logger.info(
      `AntiSpam: TRIGGERED — ${member.user.tag} (${member.id}) sent ${recentCount} messages in ${windowSec}s — guild=${guildId} — violation=${violationCount}`
    );

    state.timestamps = [];

    await this.handleSpam(message, member, cfg, reason, violationCount, client);
  }

  private async handleSpam(
    message: Message,
    member: GuildMember,
    cfg: AntiSpamConfig,
    reason: string,
    violationCount: number,
    client: Client
  ): Promise<void> {
    const guildId = member.guild.id;
    const botId = client.user?.id ?? "system";
    const punishment = PUNISHMENT_TABLE[Math.min(violationCount, 10)];

    await this.deleteMessage(message);
    logger.info(`AntiSpam: deleted message from ${member.user.tag}`);

    try {
      await this.manager
        .getHeatEngine()
        .add(member, HEAT_PER_VIOLATION, reason, false);
      logger.info(
        `AntiSpam: added +${HEAT_PER_VIOLATION} Heat for violation ${violationCount}`
      );
    } catch (err) {
      logger.warn(
        `AntiSpam: failed to add Heat — ${err instanceof Error ? err.message : String(err)}`
      );
    }

    switch (punishment.action) {
      case "warn": {
        await member
          .send(
            `⚠️ **Anti-Spam Warning ${violationCount}** in **${member.guild.name}**\n> ${reason}`
          )
          .catch(() => logger.warn(`AntiSpam: could not DM ${member.user.tag}`));
        logger.info(`AntiSpam: warned ${member.user.tag} (violation ${violationCount})`);
        break;
      }

      case "timeout": {
        try {
          const durationMs = punishment.timeoutDurationMs!;
          await member.timeout(durationMs, reason);
          const durationMin = Math.round(durationMs / 60_000);
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
        const result = await this.manager.placeInJudgment(member, reason, botId);
        if (!result.success) {
          logger.warn(`AntiSpam: judgment failed — ${result.reason}`);
        } else {
          logger.info(`AntiSpam: placed ${member.user.tag} under God's Judgment`);
        }
        break;
      }

    }

    await loggingService
      .logSecurityTrigger({
        guildId,
        module: "Anti-Spam",
        member,
        action: punishment.action,
        reason,
        extra: [
          {
            name: "Threshold",
            value: `${cfg.maxMessages} msg / ${cfg.timeWindowMs / 1_000}s`,
            inline: true,
          },
          { name: "Confirmed Violation", value: `${violationCount}`, inline: true },
          { name: "Heat Added", value: `+${HEAT_PER_VIOLATION}`, inline: true },
          ...(punishment.action === "timeout"
            ? [{ name: "Timeout", value: `${Math.round(punishment.timeoutDurationMs! / 60_000)} min`, inline: true }]
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
      gMap.set(userId, {
        timestamps: [],
        violationCount: 0,
        violationWindowStartedAt: null,
      });
    }
    return gMap.get(userId)!;
  }

  private recordViolation(guildId: string, userId: string, now: number): number {
    const state = this.getOrCreate(guildId, userId);
    if (
      state.violationWindowStartedAt === null ||
      now - state.violationWindowStartedAt >= VIOLATION_RESET_MS
    ) {
      state.violationCount = 0;
      state.violationWindowStartedAt = now;
    }

    state.violationCount += 1;
    return state.violationCount;
  }

  private clearUserState(guildId: string, userId: string): void {
    const guildTracker = this.tracker.get(guildId);
    if (!guildTracker) return;

    guildTracker.delete(userId);
    if (guildTracker.size === 0) {
      this.tracker.delete(guildId);
    }
  }

  private prune(): void {
    const now = Date.now();
    const cutoff = now - 60_000;
    for (const [guildId, gMap] of this.tracker) {
      for (const [userId, state] of gMap) {
        state.timestamps = state.timestamps.filter((t) => t > cutoff);
        if (
          state.timestamps.length === 0 &&
          (state.violationCount === 0 ||
            state.violationWindowStartedAt === null ||
            now - state.violationWindowStartedAt >= VIOLATION_RESET_MS)
        ) {
          gMap.delete(userId);
        }
      }
      if (gMap.size === 0) {
        this.tracker.delete(guildId);
      }
    }
  }

  getViolationCount(guildId: string, userId: string): number {
    return this.tracker.get(guildId)?.get(userId)?.violationCount ?? 0;
  }

  getWarnings(guildId: string, userId: string): number {
    return this.getViolationCount(guildId, userId);
  }

  resetWarnings(guildId: string, userId: string): void {
    const state = this.tracker.get(guildId)?.get(userId);
    if (state) {
      state.violationCount = 0;
      state.violationWindowStartedAt = null;
    }
  }

  getTrackedUserCount(guildId: string): number {
    return this.tracker.get(guildId)?.size ?? 0;
  }
}
