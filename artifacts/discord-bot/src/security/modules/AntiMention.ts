import { Client, Events, GuildMember, Message } from "discord.js";
import { BaseSecurityModule } from "../BaseSecurityModule.js";
import type { SecurityManager } from "../SecurityManager.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";

const MENTION_WINDOW_MS = 5_000;
const MENTION_THRESHOLD = 3;

interface MentionState {
  timestamps: number[];
}

export class AntiMention extends BaseSecurityModule {
  private readonly tracker = new Map<string, Map<string, MentionState>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(manager: SecurityManager) {
    super("antiMention", manager);
  }

  get name(): string {
    return "Anti-Mention";
  }

  get description(): string {
    return "Detects repeated mention events and adds Heat.";
  }

  register(client: Client): void {
    client.on(Events.MessageCreate, (message: Message) => {
      void this.onMessage(message);
    });
    this.cleanupTimer = setInterval(() => this.prune(), MENTION_WINDOW_MS);
    logger.info("AntiMention: registered messageCreate handler");
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.tracker.clear();
    logger.info("AntiMention: destroyed");
  }

  private async onMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot) return;
    if (!this.isEnabled(message.guildId)) return;

    const member = message.member;
    if (!member || this.isExempt(member)) return;
    if (this.isExemptChannel(message.channelId, message.guildId)) return;

    const occurrences = this.getMentionOccurrences(message);
    if (occurrences === 0) return;

    const now = Date.now();
    const state = this.getOrCreate(message.guildId, member.id);
    state.timestamps = state.timestamps.filter(
      (timestamp) => now - timestamp < MENTION_WINDOW_MS
    );
    for (let index = 0; index < occurrences; index += 1) {
      state.timestamps.push(now);
    }

    if (state.timestamps.length < MENTION_THRESHOLD) return;

    const reason = `Mention spam detected: ${state.timestamps.length} mention occurrences in 5s`;
    state.timestamps = [];

    const result = await this.manager
      .getHeatEngine()
      .addViolation(member, "mentionSpam", reason);

    await loggingService
      .logSecurityTrigger({
        guildId: message.guildId,
        module: "Anti-Mention",
        member,
        action: result.punishment.punishment,
        reason,
        extra: [
          { name: "Heat Added", value: "+15", inline: true },
          { name: "Severity", value: result.severity, inline: true },
        ],
      })
      .catch((error) =>
        logger.warn(
          `AntiMention: failed to send security log — ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
  }

  private getMentionOccurrences(message: Message): number {
    return (
      message.mentions.users.size +
      message.mentions.roles.size +
      (message.mentions.everyone ? 1 : 0)
    );
  }

  private getOrCreate(guildId: string, userId: string): MentionState {
    let guildTracker = this.tracker.get(guildId);
    if (!guildTracker) {
      guildTracker = new Map();
      this.tracker.set(guildId, guildTracker);
    }

    let state = guildTracker.get(userId);
    if (!state) {
      state = { timestamps: [] };
      guildTracker.set(userId, state);
    }
    return state;
  }

  private prune(): void {
    const cutoff = Date.now() - MENTION_WINDOW_MS;
    for (const [guildId, guildTracker] of this.tracker) {
      for (const [userId, state] of guildTracker) {
        state.timestamps = state.timestamps.filter(
          (timestamp) => timestamp > cutoff
        );
        if (state.timestamps.length === 0) guildTracker.delete(userId);
      }
      if (guildTracker.size === 0) this.tracker.delete(guildId);
    }
  }
}