import { Client, Events, Message } from "discord.js";
import { BaseSecurityModule } from "../BaseSecurityModule.js";
import type { SecurityManager } from "../SecurityManager.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";

const VIOLATION_RESET_MS = 24 * 60 * 60 * 1_000;
const ONE_HOUR_MS = 60 * 60 * 1_000;

type Punishment = "warn" | "timeout" | "judgment";

interface UserState {
  violationCount: number;
  lastViolationAt: number;
}

export class BadWordProtection extends BaseSecurityModule {
  private readonly tracker = new Map<string, Map<string, UserState>>();
  private readonly processedMessages = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private registered = false;
  private client: Client | null = null;

  constructor(manager: SecurityManager) {
    super("badWord", manager);
  }

  get name() {
    return "Bad Word Protection";
  }

  get description() {
    return "Detects configured bad words and applies the fixed violation progression.";
  }

  register(client: Client): void {
    if (this.registered) {
      logger.warn("BadWordProtection: register called more than once; ignoring duplicate listener");
      return;
    }

    this.registered = true;
    this.client = client;
    client.on(Events.MessageCreate, (message: Message) => {
      void this.onMessage(message);
    });
    this.cleanupTimer = setInterval(() => this.prune(), 30_000);
    logger.info("BadWordProtection: registered messageCreate handler");
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.tracker.clear();
    this.processedMessages.clear();
    this.registered = false;
    this.client = null;
    logger.info("BadWordProtection: destroyed");
  }

  private async onMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot) return;

    const messageKey = `${message.guildId}:${message.id}`;
    if (this.processedMessages.has(messageKey)) return;
    this.processedMessages.set(messageKey, Date.now());

    const guildId = message.guildId;
    const config = this.manager.getConfig(guildId).badWord;
    if (config.words.length === 0) return;

    const member = message.member;
    if (!member || this.manager.isBadWordExempt(member)) return;

    const matchedWord = config.words.find((word) =>
      containsConfiguredWord(message.content, word)
    );
    if (!matchedWord) return;

    const violationCount = this.recordViolation(guildId, member.id);
    const punishment = getPunishment(violationCount);
    const reason =
      `Configured bad word detected (violation ${violationCount})`;

    await this.deleteMessage(message);
    logger.info(
      `BadWordProtection: violation — ${member.user.tag} (${member.id}) ` +
      `guild=${guildId} word=${JSON.stringify(matchedWord)} violation=${violationCount}`
    );

    const action = await this.applyPunishment(member, punishment, reason);

    await loggingService
      .logSecurityTrigger({
        guildId,
        module: "Bad Word Protection",
        member,
        action,
        reason,
        extra: [
          { name: "Violation", value: String(violationCount), inline: true },
          { name: "Matched Word", value: `\`${matchedWord}\``, inline: true },
          { name: "Channel", value: `<#${message.channelId}>`, inline: true },
        ],
      })
      .catch((err) =>
        logger.warn(
          `BadWordProtection: failed to send security log — ` +
          `${err instanceof Error ? err.message : String(err)}`
        )
      );
  }

  private async applyPunishment(
    member: import("discord.js").GuildMember,
    punishment: Punishment,
    reason: string
  ): Promise<string> {
    if (punishment === "judgment") {
      const judgedBy = this.client?.user?.id ?? "bad-word-protection";
      const result = await this.manager.placeInJudgment(member, reason, judgedBy);
      if (!result.success) {
        logger.warn(`BadWordProtection: God's Judgment failed — ${result.reason}`);
      } else {
        logger.info(`BadWordProtection: placed ${member.user.tag} under God's Judgment`);
      }
      return "judgment";
    }

    const result = await this.applyAction(
      member,
      punishment === "timeout" ? "mute" : "warn",
      reason,
      punishment === "timeout" ? ONE_HOUR_MS : undefined
    );

    if (!result.success) {
      logger.warn(
        `BadWordProtection: ${punishment} failed for ${member.user.tag} — ${result.reason}`
      );
    } else {
      logger.info(
        `BadWordProtection: ${punishment} applied to ${member.user.tag}`
      );
    }

    return punishment;
  }

  private recordViolation(guildId: string, userId: string): number {
    const now = Date.now();
    let guildTracker = this.tracker.get(guildId);
    if (!guildTracker) {
      guildTracker = new Map();
      this.tracker.set(guildId, guildTracker);
    }

    const current = guildTracker.get(userId);
    const state =
      current && now - current.lastViolationAt < VIOLATION_RESET_MS
        ? current
        : { violationCount: 0, lastViolationAt: now };

    state.violationCount += 1;
    state.lastViolationAt = now;
    guildTracker.set(userId, state);
    return state.violationCount;
  }

  private prune(): void {
    const now = Date.now();

    for (const [guildId, users] of this.tracker) {
      for (const [userId, state] of users) {
        if (now - state.lastViolationAt >= VIOLATION_RESET_MS) {
          users.delete(userId);
        }
      }
      if (users.size === 0) this.tracker.delete(guildId);
    }

    for (const [messageKey, processedAt] of this.processedMessages) {
      if (now - processedAt >= VIOLATION_RESET_MS) {
        this.processedMessages.delete(messageKey);
      }
    }
  }

  getViolationCount(guildId: string, userId: string): number {
    const state = this.tracker.get(guildId)?.get(userId);
    if (!state || Date.now() - state.lastViolationAt >= VIOLATION_RESET_MS) {
      return 0;
    }
    return state.violationCount;
  }
}

function getPunishment(violationCount: number): Punishment {
  if (violationCount >= 5) return "judgment";
  if (violationCount === 4) return "timeout";
  return "warn";
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function normalizeConfiguredWord(value: string): string {
  return normalizeText(value);
}

export function isValidConfiguredWord(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}\p{M}_'’]/u.test(value);
}

function containsConfiguredWord(content: string, configuredWord: string): boolean {
  const normalizedContent = normalizeText(content);
  const normalizedWord = normalizeConfiguredWord(configuredWord);
  if (!normalizedContent || !normalizedWord) return false;

  let searchFrom = 0;
  while (searchFrom < normalizedContent.length) {
    const index = normalizedContent.indexOf(normalizedWord, searchFrom);
    if (index === -1) return false;

    const before = normalizedContent[index - 1];
    const after = normalizedContent[index + normalizedWord.length];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;

    searchFrom = index + normalizedWord.length;
  }

  return false;
}