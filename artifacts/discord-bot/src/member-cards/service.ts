import {
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import type {
  Client,
  Guild,
  GuildMember,
  Message,
  TextChannel,
} from "discord.js";
import { logger } from "../lib/logger.js";
import { renderMemberHistoryCard, renderMemberProfileCard, renderMemberRolesCard } from "./render.js";
import { memberCardStore } from "./store.js";
import type {
  MemberCardRecord,
  MemberCardKind,
  MemberCardReference,
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
type PreferredChannelResolver = (guild: Guild) => string[];
type CardKinds = readonly MemberCardKind[];

function errorCode(error: unknown): number | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : null;
}

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
  private preferredChannelResolver: PreferredChannelResolver | null = null;
  private readonly memberQueues = new Map<string, Promise<void>>();
  private readonly runningGuilds = new Set<string>();

  async init(): Promise<void> {
    await memberCardStore.init();
  }

  configure(options: {
    client: Client;
    violationCountProvider: ViolationCountProvider;
    preferredChannelResolver: PreferredChannelResolver;
  }): void {
    this.client = options.client;
    this.violationCountProvider = options.violationCountProvider;
    this.preferredChannelResolver = options.preferredChannelResolver;
  }

  async isTracked(guildId: string, userId: string): Promise<boolean> {
    return memberCardStore.isTracked(guildId, userId);
  }

  async canUseChannel(channel: TextChannel, guild: Guild): Promise<boolean> {
    return this.hasCardPermissions(channel, guild);
  }

  async renderCurrentCard(
    member: GuildMember,
    kind: MemberCardKind,
  ): Promise<Buffer> {
    const record =
      (await memberCardStore.getMember(member.guild.id, member.id)) ?? {
      createdAt: new Date().toISOString(),
      departedAt: null,
      references: {},
      changes: [],
      };
    return this.renderCard(member, kind, record);
  }

  async rememberGenerationChannel(
    guildId: string,
    channelId: string,
  ): Promise<void> {
    await memberCardStore.setGuildChannelId(guildId, channelId);
  }

  startGenerateAll(
    guild: Guild,
    destination: TextChannel,
    onProgress: (progress: GenerationProgress) => Promise<void> | void,
  ): Promise<GenerationResult> | null {
    if (this.runningGuilds.has(guild.id)) return null;
    this.runningGuilds.add(guild.id);
    const task = this.generateAll(guild, destination, onProgress).finally(() => {
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
    const destination = await this.resolveJoinDestination(currentMember.guild);
    if (!destination) {
      throw new Error(
        `No text channel with the required card permissions is available in guild ${member.guild.id}.`,
      );
    }
    await memberCardStore.setGuildChannelId(member.guild.id, destination.id);
    await this.upsertMember(currentMember, destination, ["member", "history", "roles"]);
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
      const destination = await this.resolveExistingDestination(current.guild);
      if (!destination) {
        logger.warn(
          `Member cards cannot be refreshed: no writable card channel in guild ${member.guild.id}.`,
        );
        return;
      }
      await this.upsertCardsUnlocked(current, destination, kinds);
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
      const destination = await this.resolveExistingDestination(member.guild);
      if (!destination) return;
      await this.upsertCardsUnlocked(
        member,
        destination,
        ["member", "roles"],
      );
    });
  }

  private async generateAll(
    guild: Guild,
    destination: TextChannel,
    onProgress: (progress: GenerationProgress) => Promise<void> | void,
  ): Promise<GenerationResult> {
    await memberCardStore.setGuildChannelId(guild.id, destination.id);
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
            const outcome = await this.upsertMember(
              member,
              destination,
              ["member", "history", "roles"],
            );
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
          if (progress.membersProcessed % GENERATION_BATCH_SIZE === 0) {
            await onProgress({ ...progress });
          }
          if (sincePause >= GENERATION_BATCH_SIZE) {
            sincePause = 0;
            await delay(GENERATION_BATCH_PAUSE_MS);
          }
        }
        const lastId = members.at(-1)?.id;
        if (!lastId || page.size < MEMBER_PAGE_SIZE) break;
        after = lastId;
      }
      await onProgress({ ...progress });
      return { ...progress, complete: progress.memberFailures === 0 };
    } catch (error) {
      logger.error(
        `Member pagination failed in guild ${guild.id}:`,
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      await onProgress({ ...progress });
      return { ...progress, complete: false };
    }
  }

  private async upsertMember(
    member: GuildMember,
    destination: TextChannel,
    kinds: CardKinds,
  ): Promise<{ created: number; updated: number }> {
    return this.withMemberLock(member.guild.id, member.id, async () => {
      await memberCardStore.markTracked(member.guild.id, member.id);
      const current =
        (await member.guild.members.fetch(member.id).catch(() => null)) ?? member;
      return this.upsertCardsUnlocked(current, destination, kinds);
    });
  }

  private async upsertCardsUnlocked(
    member: GuildMember,
    destination: TextChannel,
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
      const image = await this.renderCard(member, kind, record);
      const result = await this.upsertMessage(
        member,
        kind,
        image,
        destination,
        record.references[kind] ?? null,
      );
      if (result === "created") created += 1;
      else updated += 1;
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

  private async upsertMessage(
    member: GuildMember,
    kind: MemberCardKind,
    image: Buffer,
    destination: TextChannel,
    reference: MemberCardReference | null,
  ): Promise<"created" | "updated"> {
    const guildId = member.guild.id;
    if (reference) {
      const savedChannel = await this.fetchTextChannel(
        member.guild,
        reference.channelId,
      );
      if (savedChannel) {
        try {
          const message = await savedChannel.messages.fetch(reference.messageId);
          await this.editMessage(message, kind, image);
          return "updated";
        } catch (error) {
          const code = errorCode(error);
          if (code !== 10003 && code !== 10008 && code !== 50013) {
            throw error;
          }
          logger.info(
            `Member card ${kind} reference unavailable for ${member.id} in guild ${guildId}; replacing it.`,
          );
          if (code === 10003 || code === 10008) {
            await memberCardStore.clearReference(guildId, member.id, kind);
          }
        }
      } else {
        logger.info(
          `Member card channel ${reference.channelId} is unavailable in guild ${guildId}; moving ${kind} card to the active card channel.`,
        );
      }
    }

    const target = await this.requireWritableChannel(member.guild, destination);
    const message = await target.send(this.messagePayload(kind, image));
    await memberCardStore.setReference(guildId, member.id, kind, {
      channelId: target.id,
      messageId: message.id,
    });
    return "created";
  }

  private async editMessage(
    message: Message,
    kind: MemberCardKind,
    image: Buffer,
  ): Promise<void> {
    await message.edit({
      content: "",
      files: [this.attachment(kind, image)],
      attachments: [],
      components: [],
      allowedMentions: { parse: [] },
    });
  }

  private messagePayload(kind: MemberCardKind, image: Buffer) {
    return {
      files: [this.attachment(kind, image)],
      allowedMentions: { parse: [] as const },
    };
  }

  private attachment(kind: MemberCardKind, image: Buffer): AttachmentBuilder {
    const filename =
      kind === "member"
        ? "member-profile.png"
        : kind === "history"
          ? "member-history.png"
          : "member-roles.png";
    return new AttachmentBuilder(image, { name: filename });
  }

  private async resolveJoinDestination(guild: Guild): Promise<TextChannel | null> {
    const savedChannel = await memberCardStore.getGuildChannelId(guild.id);
    const preferred = [
      savedChannel,
      ...(this.preferredChannelResolver?.(guild) ?? []),
    ].filter((value): value is string => Boolean(value));
    for (const channelId of [...new Set(preferred)]) {
      const channel = await this.fetchTextChannel(guild, channelId);
      if (channel && (await this.hasCardPermissions(channel, guild))) return channel;
    }

    const system = guild.systemChannel;
    if (system && (await this.hasCardPermissions(system, guild))) return system;

    const channels = [...guild.channels.cache.values()]
      .filter(
        (channel): channel is TextChannel =>
          channel.type === ChannelType.GuildText ||
          channel.type === ChannelType.GuildAnnouncement,
      )
      .sort((left, right) => left.rawPosition - right.rawPosition);
    for (const channel of channels) {
      if (await this.hasCardPermissions(channel, guild)) return channel;
    }
    return null;
  }

  private async resolveExistingDestination(
    guild: Guild,
  ): Promise<TextChannel | null> {
    const saved = await memberCardStore.getGuildChannelId(guild.id);
    if (saved) {
      const channel = await this.fetchTextChannel(guild, saved);
      if (channel && (await this.hasCardPermissions(channel, guild))) {
        return channel;
      }
    }
    return this.resolveJoinDestination(guild);
  }

  private async fetchTextChannel(
    guild: Guild,
    channelId: string,
  ): Promise<TextChannel | null> {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (
      !channel ||
      channel.guildId !== guild.id ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement)
    ) {
      return null;
    }
    return channel as TextChannel;
  }

  private async requireWritableChannel(
    guild: Guild,
    preferred: TextChannel,
  ): Promise<TextChannel> {
    const saved = await this.fetchTextChannel(guild, preferred.id);
    if (saved && (await this.hasCardPermissions(saved, guild))) return saved;
    const fallback = await this.resolveJoinDestination(guild);
    if (fallback) return fallback;
    throw new Error(
      "No text channel is available with View Channel, Read Message History, Send Messages, and Attach Files permissions.",
    );
  }

  private async hasCardPermissions(
    channel: TextChannel,
    guild: Guild,
  ): Promise<boolean> {
    const botMember =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!botMember) return false;
    const permissions = channel.permissionsFor(botMember);
    return Boolean(
      permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
      ]),
    );
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
