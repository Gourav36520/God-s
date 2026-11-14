import type {
  Client,
  Guild,
  GuildMember,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { renderMemberHistoryCard, renderMemberProfileCard, renderMemberRolesCard } from "./render.js";
import { memberCardStore } from "./store.js";
import type {
  MemberCardRecord,
  MemberCardKind,
} from "./types.js";

const MEMBER_PAGE_SIZE = 1_000;
const GENERATION_BATCH_SIZE = 10;
const GENERATION_BATCH_PAUSE_MS = 1_000;

export interface GenerationProgress {
  membersProcessed: number;
  membersTotal: number;
  cardsCreated: number;
  cardsUpdated: number;
  memberFailures: number;
}

export interface GenerationResult extends GenerationProgress {
  complete: boolean;
}

type ViolationCountProvider = (
  guildId: string,
  userId: string,
) => Promise<number>;
type CardKinds = readonly MemberCardKind[];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function compareSnowflakes(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function formatGenerationProgress(progress: GenerationProgress): string {
  return [
    `Members processed: ${progress.membersProcessed.toLocaleString()}${progress.membersTotal ? ` / ${progress.membersTotal.toLocaleString()}` : ""}`,
    `Cards created: ${progress.cardsCreated.toLocaleString()}`,
    `Cards updated: ${progress.cardsUpdated.toLocaleString()}`,
    `Members with errors: ${progress.memberFailures.toLocaleString()}`,
  ].join("\n");
}

export class MemberCardService {
  private client: Client | null = null;
  private violationCountProvider: ViolationCountProvider | null = null;
  private readonly memberQueues = new Map<string, Promise<void>>();
  private readonly runningGuilds = new Set<string>();

  async init(): Promise<void> {
    await memberCardStore.init();
  }

  configure(options: {
    client: Client;
    violationCountProvider: ViolationCountProvider;
  }): void {
    this.client = options.client;
    this.violationCountProvider = options.violationCountProvider;
  }

  async isTracked(guildId: string, userId: string): Promise<boolean> {
    return memberCardStore.isTracked(guildId, userId);
  }

  async getStoredCard(
    member: GuildMember,
    kind: MemberCardKind,
  ): Promise<Buffer> {
    let image = await memberCardStore.getCardImage(
      member.guild.id,
      member.id,
      kind,
    );
    if (image) return image;
    await this.generateMember(member);
    image = await memberCardStore.getCardImage(
      member.guild.id,
      member.id,
      kind,
    );
    if (!image) {
      throw new Error(`Stored ${kind} card is unavailable for member ${member.id}.`);
    }
    return image;
  }

  startGenerateAll(guild: Guild): Promise<GenerationResult> | null {
    if (this.runningGuilds.has(guild.id)) return null;
    this.runningGuilds.add(guild.id);
    const task = this.generateAll(guild).finally(() => {
      this.runningGuilds.delete(guild.id);
    });
    return task;
  }

  async generateNewMember(member: GuildMember): Promise<void> {
    await delay(350);
    const currentMember = await member.guild.members
      .fetch(member.id)
      .catch(() => null);
    if (!currentMember) return;
    await this.generateMember(currentMember);
  }

  async generateMember(
    member: GuildMember,
    kinds: CardKinds = ["member", "history", "roles"],
  ): Promise<void> {
    await this.upsertMember(member, kinds);
  }

  async recordNameChange(
    member: GuildMember,
    field: "username" | "displayName" | "nickname",
    previousValue: string,
    newValue: string,
  ): Promise<void> {
    if (
      previousValue === newValue ||
      !(await memberCardStore.isTracked(member.guild.id, member.id))
    ) {
      return;
    }
    await memberCardStore.addChange(member.guild.id, member.id, {
      kind: "name",
      field,
      previousValue,
      newValue,
    });
    await this.refreshMember(member, ["member", "history"]);
  }

  async recordAvatarChange(
    member: GuildMember,
    previousValue: string | null,
    newValue: string | null,
  ): Promise<void> {
    if (
      previousValue === newValue ||
      !(await memberCardStore.isTracked(member.guild.id, member.id))
    ) {
      return;
    }
    await memberCardStore.addChange(member.guild.id, member.id, {
      kind: "avatar",
      previousValue,
      newValue,
    });
    await this.refreshMember(member, ["member", "history"]);
  }

  async refreshMember(
    member: GuildMember,
    kinds: CardKinds = ["member", "history", "roles"],
  ): Promise<void> {
    if (!(await memberCardStore.isTracked(member.guild.id, member.id))) return;
    await this.withMemberLock(member.guild.id, member.id, async () => {
      const current =
        (await member.guild.members.fetch(member.id).catch(() => null)) ?? member;
      await this.upsertCardsUnlocked(current, kinds);
    });
  }

  async refreshMemberById(guildId: string, userId: string): Promise<void> {
    if (!(await memberCardStore.isTracked(guildId, userId))) return;
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) return;
    const member =
      guild.members.cache.get(userId) ??
      (await guild.members.fetch(userId).catch(() => null));
    if (member) await this.refreshMember(member, ["roles"]);
  }

  async markMemberDeparted(member: GuildMember): Promise<void> {
    const updated = await memberCardStore.markDeparted(
      member.guild.id,
      member.id,
    );
    if (!updated) return;
    await this.withMemberLock(member.guild.id, member.id, async () => {
      await this.upsertCardsUnlocked(
        member,
        ["member", "roles"],
      );
    });
  }

  private async generateAll(guild: Guild): Promise<GenerationResult> {
    const progress: GenerationProgress = {
      membersProcessed: 0,
      membersTotal: guild.memberCount,
      cardsCreated: 0,
      cardsUpdated: 0,
      memberFailures: 0,
    };
    let after: string | undefined;
    let sincePause = 0;
    try {
      for (;;) {
        const page = await guild.members.fetch({
          limit: MEMBER_PAGE_SIZE,
          ...(after ? { after } : {}),
          withPresences: false,
        });
        if (page.size === 0) break;
        const members = [...page.values()].sort((a, b) =>
          compareSnowflakes(a.id, b.id),
        );
        for (const member of members) {
          try {
            const outcome = await this.upsertMember(member, [
              "member",
              "history",
              "roles",
            ]);
            progress.cardsCreated += outcome.created;
            progress.cardsUpdated += outcome.updated;
          } catch (error) {
            progress.memberFailures += 1;
            logger.warn(
              `Member card generation failed for user ${member.id} in guild ${guild.id}:`,
              error instanceof Error ? error.message : "unknown error",
            );
          }
          progress.membersProcessed += 1;
          sincePause += 1;
          if (sincePause >= GENERATION_BATCH_SIZE) {
            sincePause = 0;
            await delay(GENERATION_BATCH_PAUSE_MS);
          }
        }
        const lastId = members.at(-1)?.id;
        if (!lastId || page.size < MEMBER_PAGE_SIZE) break;
        after = lastId;
      }
      return { ...progress, complete: progress.memberFailures === 0 };
    } catch (error) {
      logger.error(
        `Member pagination failed in guild ${guild.id}:`,
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return { ...progress, complete: false };
    }
  }

  private async upsertMember(
    member: GuildMember,
    kinds: CardKinds,
  ): Promise<{ created: number; updated: number }> {
    return this.withMemberLock(member.guild.id, member.id, async () => {
      await memberCardStore.markTracked(member.guild.id, member.id);
      const current =
        (await member.guild.members.fetch(member.id).catch(() => null)) ?? member;
      return this.upsertCardsUnlocked(current, kinds);
    });
  }

  private async upsertCardsUnlocked(
    member: GuildMember,
    kinds: CardKinds,
  ): Promise<{ created: number; updated: number }> {
    const record = await memberCardStore.getMember(
      member.guild.id,
      member.id,
    );
    if (!record) {
      throw new Error("Member card tracking record is missing.");
    }
    let created = 0;
    let updated = 0;
    for (const kind of kinds) {
      const existed = Boolean(
        await memberCardStore.getCardImage(member.guild.id, member.id, kind),
      );
      const image = await this.renderCard(member, kind, record);
      await memberCardStore.saveCardImage(
        member.guild.id,
        member.id,
        kind,
        image,
      );
      if (existed) updated += 1;
      else created += 1;
    }
    return { created, updated };
  }

  private async renderCard(
    member: GuildMember,
    kind: MemberCardKind,
    record: MemberCardRecord,
  ): Promise<Buffer> {
    if (kind === "member") {
      return renderMemberProfileCard(member, record.departedAt);
    }
    if (kind === "history") {
      const changes = [...record.changes].sort(
        (left, right) =>
          new Date(right.occurredAt).getTime() -
          new Date(left.occurredAt).getTime(),
      );
      return renderMemberHistoryCard(member, changes);
    }
    let violationCount: number | null = null;
    try {
      if (!this.violationCountProvider) {
        throw new Error("Violation count provider is not configured.");
      }
      violationCount = await this.violationCountProvider(
        member.guild.id,
        member.id,
      );
    } catch (error) {
      logger.warn(
        `Member violation count unavailable for ${member.id} in guild ${member.guild.id}:`,
        error instanceof Error ? error.message : "unknown error",
      );
    }
    return renderMemberRolesCard(member, violationCount, record.departedAt);
  }

  private async withMemberLock<T>(
    guildId: string,
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${guildId}:${userId}`;
    const previous = this.memberQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.memberQueues.set(key, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.memberQueues.get(key) === queued) {
        this.memberQueues.delete(key);
      }
    }
  }
}

export const memberCardService = new MemberCardService();
