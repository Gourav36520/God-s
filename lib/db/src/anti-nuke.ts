import { and, desc, eq } from "drizzle-orm";
import { db } from "./connection.js";
import {
  antiNukeGuildConfigTable,
  antiNukeIncidentsTable,
} from "./schema/anti-nuke.js";

export interface AntiNukeIncidentRow {
  id: string;
  guildId: string;
  eventKey: string | null;
  detector: string;
  executorId: string | null;
  targetId: string | null;
  action: string;
  thresholdCount: number;
  response: string;
  outcome: string;
  details: Record<string, unknown>;
  occurredAt: Date;
}

export async function loadAntiNukeConfigRows(): Promise<
  { guildId: string; config: Record<string, unknown> }[]
> {
  return db
    .select({
      guildId: antiNukeGuildConfigTable.guildId,
      config: antiNukeGuildConfigTable.config,
    })
    .from(antiNukeGuildConfigTable);
}

export async function saveAntiNukeConfigRow(
  guildId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(antiNukeGuildConfigTable)
    .values({ guildId, config, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: antiNukeGuildConfigTable.guildId,
      set: { config, updatedAt: new Date() },
    });
}

export async function createAntiNukeIncidentRow(
  incident: AntiNukeIncidentRow,
): Promise<boolean> {
  const inserted = await db
    .insert(antiNukeIncidentsTable)
    .values(incident)
    .onConflictDoNothing({
      target: [
        antiNukeIncidentsTable.guildId,
        antiNukeIncidentsTable.eventKey,
      ],
    })
    .returning({ id: antiNukeIncidentsTable.id });
  return inserted.length > 0;
}

export async function updateAntiNukeIncidentOutcome(
  guildId: string,
  id: string,
  outcome: string,
  details: Record<string, unknown>,
): Promise<void> {
  await db
    .update(antiNukeIncidentsTable)
    .set({ outcome, details })
    .where(
      and(
        eq(antiNukeIncidentsTable.guildId, guildId),
        eq(antiNukeIncidentsTable.id, id),
      ),
    );
}

export async function findAntiNukeIncidentRow(
  guildId: string,
  id: string,
): Promise<AntiNukeIncidentRow | null> {
  const rows = await db
    .select()
    .from(antiNukeIncidentsTable)
    .where(
      and(
        eq(antiNukeIncidentsTable.guildId, guildId),
        eq(antiNukeIncidentsTable.id, id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listAntiNukeIncidentRows(
  guildId: string,
  filters: { executorId?: string; targetId?: string; detector?: string },
  limit = 10,
): Promise<AntiNukeIncidentRow[]> {
  const conditions = [eq(antiNukeIncidentsTable.guildId, guildId)];
  if (filters.executorId) {
    conditions.push(eq(antiNukeIncidentsTable.executorId, filters.executorId));
  }
  if (filters.targetId) {
    conditions.push(eq(antiNukeIncidentsTable.targetId, filters.targetId));
  }
  if (filters.detector) {
    conditions.push(eq(antiNukeIncidentsTable.detector, filters.detector));
  }

  return db
    .select()
    .from(antiNukeIncidentsTable)
    .where(and(...conditions))
    .orderBy(desc(antiNukeIncidentsTable.occurredAt))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 25));
}
