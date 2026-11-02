import { drizzle } from "drizzle-orm/node-postgres";
import { and, desc, eq, isNull } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema/index.js";
import { moderationCases } from "./schema/moderation.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema/index.js";

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
