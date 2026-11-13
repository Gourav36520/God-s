import {
  createMemberProfileChange,
  deleteMemberCardMessage,
  ensureMemberCardTracked,
  getMemberCardChannel,
  getMemberCardData,
  isMemberCardTracked,
  markMemberCardDeparted,
  saveMemberCardChannel,
  saveMemberCardMessage,
} from "@workspace/db";
import type {
  MemberCardKind,
  MemberCardRecord,
  MemberCardReference,
  MemberProfileChange,
  NewMemberProfileChange,
} from "./types.js";

function isCardKind(value: string): value is MemberCardKind {
  return value === "member" || value === "history" || value === "roles";
}

function mapChange(
  change: Awaited<ReturnType<typeof getMemberCardData>>["changes"][number],
): MemberProfileChange {
  const occurredAt = change.occurredAt.toISOString();
  if (
    change.kind === "name" &&
    (change.field === "username" ||
      change.field === "displayName" ||
      change.field === "nickname") &&
    change.previousValue !== null &&
    change.newValue !== null
  ) {
    return {
      id: String(change.id),
      kind: "name",
      field: change.field,
      previousValue: change.previousValue,
      newValue: change.newValue,
      occurredAt,
    };
  }
  if (change.kind === "avatar") {
    return {
      id: String(change.id),
      kind: "avatar",
      previousValue: change.previousValue,
      newValue: change.newValue,
      occurredAt,
    };
  }
  throw new Error(`Invalid member profile history record ${change.id}`);
}

export class MemberCardStore {
  private initialized = false;

  async init(): Promise<void> {
    const schemaCheckId = "__member_card_schema_check__";
    await Promise.all([
      getMemberCardChannel(schemaCheckId),
      getMemberCardData(schemaCheckId, schemaCheckId),
    ]);
    this.initialized = true;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Member card storage has not been initialized");
    }
  }

  async setGuildChannelId(guildId: string, channelId: string): Promise<void> {
    this.assertInitialized();
    await saveMemberCardChannel(guildId, channelId);
  }

  async getGuildChannelId(guildId: string): Promise<string | null> {
    this.assertInitialized();
    return getMemberCardChannel(guildId);
  }

  async isTracked(guildId: string, userId: string): Promise<boolean> {
    this.assertInitialized();
    return isMemberCardTracked(guildId, userId);
  }

  async markTracked(guildId: string, userId: string): Promise<void> {
    this.assertInitialized();
    await ensureMemberCardTracked(guildId, userId);
  }

  async markDeparted(
    guildId: string,
    userId: string,
    departedAt = new Date(),
  ): Promise<boolean> {
    this.assertInitialized();
    return markMemberCardDeparted(guildId, userId, departedAt);
  }

  async getMember(
    guildId: string,
    userId: string,
  ): Promise<MemberCardRecord | null> {
    this.assertInitialized();
    const data = await getMemberCardData(guildId, userId);
    if (!data.member) return null;

    const references: Partial<Record<MemberCardKind, MemberCardReference>> = {};
    for (const reference of data.references) {
      if (!isCardKind(reference.cardKind)) {
        throw new Error(
          `Invalid member card kind ${reference.cardKind} for ${guildId}/${userId}`,
        );
      }
      references[reference.cardKind] = {
        channelId: reference.channelId,
        messageId: reference.messageId,
      };
    }

    return {
      createdAt: data.member.createdAt.toISOString(),
      departedAt: data.member.departedAt?.toISOString() ?? null,
      references,
      changes: data.changes.map(mapChange),
    };
  }

  async setReference(
    guildId: string,
    userId: string,
    kind: MemberCardKind,
    reference: MemberCardReference,
  ): Promise<void> {
    this.assertInitialized();
    await saveMemberCardMessage({
      guildId,
      userId,
      cardKind: kind,
      channelId: reference.channelId,
      messageId: reference.messageId,
    });
  }

  async clearReference(
    guildId: string,
    userId: string,
    kind: MemberCardKind,
  ): Promise<void> {
    this.assertInitialized();
    await deleteMemberCardMessage(guildId, userId, kind);
  }

  async addChange(
    guildId: string,
    userId: string,
    change: NewMemberProfileChange,
  ): Promise<void> {
    this.assertInitialized();
    const occurredAt = change.occurredAt
      ? new Date(change.occurredAt)
      : new Date();
    if (!Number.isFinite(occurredAt.getTime())) {
      throw new Error("Invalid timestamp for member profile history");
    }
    await createMemberProfileChange({
      guildId,
      userId,
      kind: change.kind,
      field: change.kind === "name" ? change.field : null,
      previousValue: change.previousValue,
      newValue: change.newValue,
      occurredAt,
    });
  }
}

export const memberCardStore = new MemberCardStore();
