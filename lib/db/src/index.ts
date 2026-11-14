import { drizzle } from "drizzle-orm/node-postgres";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  lt,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema/index.js";
import {
  antiNukeGuildConfigs,
  antiNukeIncidents,
} from "./schema/antinuke.js";
import {
  moderationBanExpirations,
  moderationCases,
} from "./schema/moderation.js";
import {
  memberCardImages,
  memberCardMembers,
  memberProfileChanges,
} from "./schema/member-cards.js";
import {
  levelingGuildSettings,
  levelingInviteRewards,
  levelingMembers,
  levelingMessageSignatures,
  levelingRoleRewards,
  levelingXpEvents,
} from "./schema/leveling.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema/index.js";
export * from "./backup-store.js";

export async function loadAntiNukeConfigRows(): Promise<
  Pick<schema.AntiNukeGuildConfig, "guildId" | "config">[]
> {
  return db
    .select({
      guildId: antiNukeGuildConfigs.guildId,
      config: antiNukeGuildConfigs.config,
    })
    .from(antiNukeGuildConfigs);
}

export async function saveAntiNukeConfigRow(
  guildId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(antiNukeGuildConfigs)
    .values({ guildId, config })
    .onConflictDoUpdate({
      target: antiNukeGuildConfigs.guildId,
      set: { config, updatedAt: new Date() },
    });
}

export async function createAntiNukeIncidentRow(
  values: schema.NewAntiNukeIncident,
): Promise<boolean> {
  const [created] = await db
    .insert(antiNukeIncidents)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: antiNukeIncidents.id });

  return Boolean(created);
}

export async function findAntiNukeIncidentRow(
  guildId: string,
  id: string,
): Promise<schema.AntiNukeIncidentRow | null> {
  const [incident] = await db
    .select()
    .from(antiNukeIncidents)
    .where(
      and(
        eq(antiNukeIncidents.guildId, guildId),
        eq(antiNukeIncidents.id, id),
      ),
    )
    .limit(1);

  return incident ?? null;
}

export async function listAntiNukeIncidentRows(
  guildId: string,
  filters: {
    executorId?: string;
    targetId?: string;
    detector?: string;
  } = {},
  limit = 10,
): Promise<schema.AntiNukeIncidentRow[]> {
  const conditions = [eq(antiNukeIncidents.guildId, guildId)];
  if (filters.executorId) {
    conditions.push(eq(antiNukeIncidents.executorId, filters.executorId));
  }
  if (filters.targetId) {
    conditions.push(eq(antiNukeIncidents.targetId, filters.targetId));
  }
  if (filters.detector) {
    conditions.push(eq(antiNukeIncidents.detector, filters.detector));
  }

  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(100, Math.floor(limit)))
    : 10;

  return db
    .select()
    .from(antiNukeIncidents)
    .where(and(...conditions))
    .orderBy(desc(antiNukeIncidents.occurredAt))
    .limit(safeLimit);
}

export async function updateAntiNukeIncidentOutcome(
  guildId: string,
  id: string,
  outcome: string,
  details: Record<string, unknown>,
): Promise<boolean> {
  const [updated] = await db
    .update(antiNukeIncidents)
    .set({ outcome, details })
    .where(
      and(
        eq(antiNukeIncidents.guildId, guildId),
        eq(antiNukeIncidents.id, id),
      ),
    )
    .returning({ id: antiNukeIncidents.id });

  return Boolean(updated);
}

export async function createModerationCase(
  values: schema.NewModerationCase,
): Promise<number> {
  const [created] = await db
    .insert(moderationCases)
    .values(values)
    .returning({ id: moderationCases.id });

  if (!created) {
    throw new Error("The moderation case was not saved.");
  }
  return created.id;
}

export async function isMemberCardTracked(
  guildId: string,
  userId: string,
): Promise<boolean> {
  const [member] = await db
    .select({ userId: memberCardMembers.userId })
    .from(memberCardMembers)
    .where(
      and(
        eq(memberCardMembers.guildId, guildId),
        eq(memberCardMembers.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(member);
}

export async function ensureMemberCardTracked(
  guildId: string,
  userId: string,
): Promise<void> {
  await db
    .insert(memberCardMembers)
    .values({ guildId, userId, departedAt: null })
    .onConflictDoUpdate({
      target: [memberCardMembers.guildId, memberCardMembers.userId],
      set: { departedAt: null },
    });
}

export async function markMemberCardDeparted(
  guildId: string,
  userId: string,
  departedAt: Date,
): Promise<boolean> {
  const [updated] = await db
    .update(memberCardMembers)
    .set({ departedAt })
    .where(
      and(
        eq(memberCardMembers.guildId, guildId),
        eq(memberCardMembers.userId, userId),
      ),
    )
    .returning({ userId: memberCardMembers.userId });
  return Boolean(updated);
}

export async function getMemberCardData(
  guildId: string,
  userId: string,
): Promise<{
  member: schema.MemberCardMember | null;
  changes: schema.MemberProfileChangeRow[];
}> {
  const [members, changes] = await Promise.all([
    db
      .select()
      .from(memberCardMembers)
      .where(
        and(
          eq(memberCardMembers.guildId, guildId),
          eq(memberCardMembers.userId, userId),
        ),
      )
      .limit(1),
    db
      .select()
      .from(memberProfileChanges)
      .where(
        and(
          eq(memberProfileChanges.guildId, guildId),
          eq(memberProfileChanges.userId, userId),
        ),
      )
      .orderBy(
        desc(memberProfileChanges.occurredAt),
        desc(memberProfileChanges.id),
      ),
  ]);
  return {
    member: members[0] ?? null,
    changes,
  };
}

export async function getMemberCardImage(
  guildId: string,
  userId: string,
  cardKind: string,
): Promise<Buffer | null> {
  const [image] = await db
    .select({ imageData: memberCardImages.imageData })
    .from(memberCardImages)
    .where(
      and(
        eq(memberCardImages.guildId, guildId),
        eq(memberCardImages.userId, userId),
        eq(memberCardImages.cardKind, cardKind),
      ),
    )
    .limit(1);
  return image?.imageData ?? null;
}

export async function saveMemberCardImage(
  guildId: string,
  userId: string,
  cardKind: string,
  imageData: Buffer,
): Promise<void> {
  await db
    .insert(memberCardMembers)
    .values({ guildId, userId, departedAt: null })
    .onConflictDoNothing();
  await db
    .insert(memberCardImages)
    .values({ guildId, userId, cardKind, imageData })
    .onConflictDoUpdate({
      target: [
        memberCardImages.guildId,
        memberCardImages.userId,
        memberCardImages.cardKind,
      ],
      set: { imageData, updatedAt: new Date() },
    });
}

export async function createMemberProfileChange(
  values: schema.InsertMemberProfileChange,
): Promise<void> {
  await db.insert(memberProfileChanges).values(values);
}

export async function createModerationBanExpiration(
  values: schema.NewModerationBanExpiration,
): Promise<number> {
  const [created] = await db
    .insert(moderationBanExpirations)
    .values(values)
    .returning({ id: moderationBanExpirations.id });

  if (!created) {
    throw new Error("The temporary ban expiry was not saved.");
  }
  return created.id;
}

export async function listDueModerationBanExpirations(
  now = new Date(),
  limit = 25,
): Promise<schema.ModerationBanExpiration[]> {
  return db
    .select()
    .from(moderationBanExpirations)
    .where(
      and(
        lte(moderationBanExpirations.expiresAt, now),
        isNull(moderationBanExpirations.resolvedAt),
        or(
          isNull(moderationBanExpirations.retryAt),
          lte(moderationBanExpirations.retryAt, now),
        ),
      ),
    )
    .orderBy(asc(moderationBanExpirations.expiresAt))
    .limit(limit);
}

export async function resolveModerationBanExpiration(
  id: number,
): Promise<boolean> {
  const [updated] = await db
    .update(moderationBanExpirations)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(moderationBanExpirations.id, id),
        isNull(moderationBanExpirations.resolvedAt),
      ),
    )
    .returning({ id: moderationBanExpirations.id });

  return Boolean(updated);
}

export async function deferModerationBanExpiration(
  id: number,
  retryAt: Date,
): Promise<boolean> {
  const [updated] = await db
    .update(moderationBanExpirations)
    .set({ retryAt })
    .where(
      and(
        eq(moderationBanExpirations.id, id),
        isNull(moderationBanExpirations.resolvedAt),
      ),
    )
    .returning({ id: moderationBanExpirations.id });

  return Boolean(updated);
}

export async function resolveModerationBanExpirationsForTarget(
  guildId: string,
  targetId: string,
): Promise<number> {
  const updated = await db
    .update(moderationBanExpirations)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(moderationBanExpirations.guildId, guildId),
        eq(moderationBanExpirations.targetId, targetId),
        isNull(moderationBanExpirations.resolvedAt),
      ),
    )
    .returning({ id: moderationBanExpirations.id });

  return updated.length;
}

export async function listModerationWarnings(
  guildId: string,
  targetId: string,
  limit = 20,
): Promise<schema.ModerationCase[]> {
  return db
    .select()
    .from(moderationCases)
    .where(
      and(
        eq(moderationCases.guildId, guildId),
        eq(moderationCases.targetId, targetId),
        eq(moderationCases.action, "warn"),
        isNull(moderationCases.resolvedAt),
      ),
    )
    .orderBy(desc(moderationCases.createdAt))
    .limit(limit);
}

export async function listModerationCases(
  guildId: string,
  targetId: string,
  limit = 10,
): Promise<schema.ModerationCase[]> {
  return db
    .select()
    .from(moderationCases)
    .where(
      and(
        eq(moderationCases.guildId, guildId),
        eq(moderationCases.targetId, targetId),
      ),
    )
    .orderBy(desc(moderationCases.createdAt))
    .limit(limit);
}

export async function countModerationViolationCases(
  guildId: string,
  targetId: string,
): Promise<number> {
  const [result] = await db
    .select({ total: count() })
    .from(moderationCases)
    .where(
      and(
        eq(moderationCases.guildId, guildId),
        eq(moderationCases.targetId, targetId),
        inArray(moderationCases.action, [
          "warn",
          "kick",
          "ban",
          "softban",
          "softban-partial",
          "timeout",
          "server-mute",
        ]),
      ),
    );
  return Number(result?.total ?? 0);
}

export async function resolveModerationWarning(
  guildId: string,
  targetId: string,
  caseId: number,
  moderatorId: string,
): Promise<boolean> {
  const [updated] = await db
    .update(moderationCases)
    .set({ resolvedAt: new Date(), resolvedBy: moderatorId })
    .where(
      and(
        eq(moderationCases.id, caseId),
        eq(moderationCases.guildId, guildId),
        eq(moderationCases.targetId, targetId),
        eq(moderationCases.action, "warn"),
        isNull(moderationCases.resolvedAt),
      ),
    )
    .returning({ id: moderationCases.id });

  return Boolean(updated);
}

export async function resolveAllModerationWarnings(
  guildId: string,
  targetId: string,
  moderatorId: string,
): Promise<number> {
  const updated = await db
    .update(moderationCases)
    .set({ resolvedAt: new Date(), resolvedBy: moderatorId })
    .where(
      and(
        eq(moderationCases.guildId, guildId),
        eq(moderationCases.targetId, targetId),
        eq(moderationCases.action, "warn"),
        isNull(moderationCases.resolvedAt),
      ),
    )
    .returning({ id: moderationCases.id });

  return updated.length;
}

export interface LevelXpAwardResult {
  previousXp: bigint;
  totalXp: bigint;
  amount: bigint;
  duplicate: boolean;
}

export async function ensureLevelingMember(
  guildId: string,
  userId: string,
): Promise<schema.LevelingMember> {
  await db
    .insert(levelingMembers)
    .values({ guildId, userId, departedAt: null })
    .onConflictDoUpdate({
      target: [levelingMembers.guildId, levelingMembers.userId],
      set: { departedAt: null },
    });
  const [member] = await db
    .select()
    .from(levelingMembers)
    .where(
      and(
        eq(levelingMembers.guildId, guildId),
        eq(levelingMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!member) throw new Error("Leveling member could not be loaded.");
  return member;
}

export async function getLevelingMember(
  guildId: string,
  userId: string,
): Promise<schema.LevelingMember | null> {
  const [member] = await db
    .select()
    .from(levelingMembers)
    .where(
      and(
        eq(levelingMembers.guildId, guildId),
        eq(levelingMembers.userId, userId),
      ),
    )
    .limit(1);
  return member ?? null;
}

export async function getLevelingMemberRank(
  guildId: string,
  userId: string,
  totalXp: bigint,
): Promise<number> {
  const [result] = await db
    .select({ ahead: count() })
    .from(levelingMembers)
    .where(
      and(
        eq(levelingMembers.guildId, guildId),
        isNull(levelingMembers.departedAt),
        or(
          gt(levelingMembers.totalXp, totalXp),
          and(
            eq(levelingMembers.totalXp, totalXp),
            lt(levelingMembers.userId, userId),
          ),
        ),
      ),
    );
  return Number(result?.ahead ?? 0) + 1;
}

export async function addLevelXp(
  guildId: string,
  userId: string,
  source: "message" | "voice" | "invite",
  sourceKey: string,
  amount: bigint,
  now = new Date(),
): Promise<LevelXpAwardResult> {
  if (amount <= 0n) throw new Error("XP awards must be positive.");
  return db.transaction(async (tx) => {
    await tx
      .insert(levelingMembers)
      .values({ guildId, userId, departedAt: null })
      .onConflictDoNothing();
    const [member] = await tx
      .select()
      .from(levelingMembers)
      .where(
        and(
          eq(levelingMembers.guildId, guildId),
          eq(levelingMembers.userId, userId),
        ),
      )
      .for("update")
      .limit(1);
    if (!member) throw new Error("Leveling member could not be loaded.");

    const [event] = await tx
      .insert(levelingXpEvents)
      .values({ guildId, userId, source, sourceKey, amount, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: levelingXpEvents.id });
    if (!event) {
      return {
        previousXp: member.totalXp,
        totalXp: member.totalXp,
        amount: 0n,
        duplicate: true,
      };
    }

    const totalXp = member.totalXp + amount;
    await tx
      .update(levelingMembers)
      .set({ totalXp, recentXp: amount, recentXpAt: now, updatedAt: now })
      .where(
        and(
          eq(levelingMembers.guildId, guildId),
          eq(levelingMembers.userId, userId),
        ),
      );
    return {
      previousXp: member.totalXp,
      totalXp,
      amount,
      duplicate: false,
    };
  });
}

export async function awardLevelMessageXp(input: {
  guildId: string;
  userId: string;
  messageId: string;
  signature: string;
  amount: bigint;
  cooldownMs: number;
  signatureLifetimeMs: number;
  now?: Date;
}): Promise<LevelXpAwardResult | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx
      .insert(levelingMembers)
      .values({
        guildId: input.guildId,
        userId: input.userId,
        departedAt: null,
      })
      .onConflictDoNothing();
    const [member] = await tx
      .select()
      .from(levelingMembers)
      .where(
        and(
          eq(levelingMembers.guildId, input.guildId),
          eq(levelingMembers.userId, input.userId),
        ),
      )
      .for("update")
      .limit(1);
    if (!member) throw new Error("Leveling member could not be loaded.");
    if (
      member.lastMessageXpAt &&
      now.getTime() - member.lastMessageXpAt.getTime() < input.cooldownMs
    ) {
      return null;
    }

    await tx
      .delete(levelingMessageSignatures)
      .where(
        and(
          eq(levelingMessageSignatures.guildId, input.guildId),
          eq(levelingMessageSignatures.userId, input.userId),
          lte(levelingMessageSignatures.expiresAt, now),
        ),
      );
    const [signature] = await tx
      .insert(levelingMessageSignatures)
      .values({
        guildId: input.guildId,
        userId: input.userId,
        signature: input.signature,
        expiresAt: new Date(now.getTime() + input.signatureLifetimeMs),
      })
      .onConflictDoNothing()
      .returning({ signature: levelingMessageSignatures.signature });
    if (!signature) return null;

    const [event] = await tx
      .insert(levelingXpEvents)
      .values({
        guildId: input.guildId,
        userId: input.userId,
        source: "message",
        sourceKey: input.messageId,
        amount: input.amount,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: levelingXpEvents.id });
    if (!event) {
      return {
        previousXp: member.totalXp,
        totalXp: member.totalXp,
        amount: 0n,
        duplicate: true,
      };
    }

    const totalXp = member.totalXp + input.amount;
    await tx
      .update(levelingMembers)
      .set({
        totalXp,
        recentXp: input.amount,
        recentXpAt: now,
        lastMessageXpAt: now,
        departedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(levelingMembers.guildId, input.guildId),
          eq(levelingMembers.userId, input.userId),
        ),
      );
    return {
      previousXp: member.totalXp,
      totalXp,
      amount: input.amount,
      duplicate: false,
    };
  });
}

export async function awardLevelVoiceXp(input: {
  guildId: string;
  userId: string;
  sourceKey: string;
  dayKey: string;
  amount: bigint;
  intervalMs: number;
  intervalMinutes: number;
  dailyLimitMinutes: number;
  now?: Date;
}): Promise<LevelXpAwardResult | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx
      .insert(levelingMembers)
      .values({ guildId: input.guildId, userId: input.userId, departedAt: null })
      .onConflictDoNothing();
    const [member] = await tx
      .select()
      .from(levelingMembers)
      .where(
        and(
          eq(levelingMembers.guildId, input.guildId),
          eq(levelingMembers.userId, input.userId),
        ),
      )
      .for("update")
      .limit(1);
    if (!member) throw new Error("Leveling member could not be loaded.");
    if (
      member.lastVoiceXpAt &&
      now.getTime() - member.lastVoiceXpAt.getTime() < input.intervalMs
    ) {
      return null;
    }
    const sameDay = member.voiceXpDayKey === input.dayKey;
    const voiceXpMinutes = sameDay ? member.voiceXpMinutes : 0;
    if (voiceXpMinutes >= input.dailyLimitMinutes) return null;

    const [event] = await tx
      .insert(levelingXpEvents)
      .values({
        guildId: input.guildId,
        userId: input.userId,
        source: "voice",
        sourceKey: input.sourceKey,
        amount: input.amount,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: levelingXpEvents.id });
    if (!event) {
      return {
        previousXp: member.totalXp,
        totalXp: member.totalXp,
        amount: 0n,
        duplicate: true,
      };
    }

    const totalXp = member.totalXp + input.amount;
    await tx
      .update(levelingMembers)
      .set({
        totalXp,
        recentXp: input.amount,
        recentXpAt: now,
        lastVoiceXpAt: now,
        voiceXpDayKey: input.dayKey,
        voiceXpMinutes: voiceXpMinutes + input.intervalMinutes,
        departedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(levelingMembers.guildId, input.guildId),
          eq(levelingMembers.userId, input.userId),
        ),
      );
    return {
      previousXp: member.totalXp,
      totalXp,
      amount: input.amount,
      duplicate: false,
    };
  });
}

export async function getLevelingSettings(
  guildId: string,
): Promise<schema.LevelingGuildSettings | null> {
  const [settings] = await db
    .select()
    .from(levelingGuildSettings)
    .where(eq(levelingGuildSettings.guildId, guildId))
    .limit(1);
  return settings ?? null;
}

export async function setLevelingAnnouncementChannel(
  guildId: string,
  channelId: string,
): Promise<void> {
  await db
    .insert(levelingGuildSettings)
    .values({ guildId, announcementChannelId: channelId })
    .onConflictDoUpdate({
      target: levelingGuildSettings.guildId,
      set: { announcementChannelId: channelId, updatedAt: new Date() },
    });
}

export async function getLevelingRoleRewards(
  guildId: string,
): Promise<schema.LevelingRoleReward[]> {
  return db
    .select()
    .from(levelingRoleRewards)
    .where(eq(levelingRoleRewards.guildId, guildId))
    .orderBy(asc(levelingRoleRewards.level));
}

export async function setLevelingRoleReward(
  guildId: string,
  level: number,
  roleId: string,
): Promise<void> {
  await db
    .insert(levelingRoleRewards)
    .values({ guildId, level, roleId })
    .onConflictDoUpdate({
      target: [levelingRoleRewards.guildId, levelingRoleRewards.level],
      set: { roleId, createdAt: new Date() },
    });
}

export async function removeLevelingRoleReward(
  guildId: string,
  level: number,
): Promise<boolean> {
  const [deleted] = await db
    .delete(levelingRoleRewards)
    .where(
      and(
        eq(levelingRoleRewards.guildId, guildId),
        eq(levelingRoleRewards.level, level),
      ),
    )
    .returning({ level: levelingRoleRewards.level });
  return Boolean(deleted);
}

export async function addPendingLevelingInviteReward(input: {
  guildId: string;
  inviteeId: string;
  inviterId: string;
  joinedAt: Date;
  eligibleAt: Date;
  status?: "pending" | "forfeited";
  reason?: string | null;
}): Promise<boolean> {
  const [created] = await db
    .insert(levelingInviteRewards)
    .values({
      guildId: input.guildId,
      inviteeId: input.inviteeId,
      inviterId: input.inviterId,
      joinedAt: input.joinedAt,
      eligibleAt: input.eligibleAt,
      status: input.status ?? "pending",
      reason: input.reason ?? null,
    })
    .onConflictDoNothing()
    .returning({ inviteeId: levelingInviteRewards.inviteeId });
  return Boolean(created);
}

export async function listDueLevelingInviteRewards(
  now = new Date(),
  limit = 100,
): Promise<schema.LevelingInviteReward[]> {
  return db
    .select()
    .from(levelingInviteRewards)
    .where(
      and(
        eq(levelingInviteRewards.status, "pending"),
        lte(levelingInviteRewards.eligibleAt, now),
      ),
    )
    .orderBy(asc(levelingInviteRewards.eligibleAt))
    .limit(limit);
}

export async function setLevelingInviteRewardStatus(
  guildId: string,
  inviteeId: string,
  status: "awarded" | "forfeited",
  reason: string | null,
  awardedAt: Date | null = null,
): Promise<boolean> {
  const [updated] = await db
    .update(levelingInviteRewards)
    .set({ status, reason, awardedAt })
    .where(
      and(
        eq(levelingInviteRewards.guildId, guildId),
        eq(levelingInviteRewards.inviteeId, inviteeId),
        eq(levelingInviteRewards.status, "pending"),
      ),
    )
    .returning({ inviteeId: levelingInviteRewards.inviteeId });
  return Boolean(updated);
}

export async function forfeitPendingLevelingInviteReward(
  guildId: string,
  inviteeId: string,
  reason: string,
): Promise<boolean> {
  return setLevelingInviteRewardStatus(
    guildId,
    inviteeId,
    "forfeited",
    reason,
  );
}

export async function markLevelingMemberDeparted(
  guildId: string,
  userId: string,
  departedAt = new Date(),
): Promise<void> {
  await db
    .update(levelingMembers)
    .set({ departedAt, updatedAt: departedAt })
    .where(
      and(
        eq(levelingMembers.guildId, guildId),
        eq(levelingMembers.userId, userId),
      ),
    );
}
