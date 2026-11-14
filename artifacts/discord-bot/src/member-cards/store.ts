import {
  ensureMemberCardTracked,
  getMemberCardData,
  getMemberCardImage,
  isMemberCardTracked,
  markMemberCardDeparted,
  saveMemberCardImage,
  createMemberProfileChange,
} from "@workspace/db";
import type {
  MemberCardKind,
  MemberCardRecord,
  MemberProfileChange,
  NewMemberProfileChange,
} from "./types.js";

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
      getMemberCardData(schemaCheckId, schemaCheckId),
      getMemberCardImage(schemaCheckId, schemaCheckId, "member"),
    ]);
    this.initialized = true;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Member card storage has not been initialized");
    }
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

    return {
      createdAt: data.member.createdAt.toISOString(),
      departedAt: data.member.departedAt?.toISOString() ?? null,
      changes: data.changes.map(mapChange),
    };
  }

  async getCardImage(
    guildId: string,
    userId: string,
    kind: MemberCardKind,
  ): Promise<Buffer | null> {
    this.assertInitialized();
    return getMemberCardImage(guildId, userId, kind);
  }

  async saveCardImage(
    guildId: string,
    userId: string,
    kind: MemberCardKind,
    image: Buffer,
  ): Promise<void> {
    this.assertInitialized();
    await saveMemberCardImage(guildId, userId, kind, image);
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
