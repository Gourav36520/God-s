import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const antiNukeGuildConfigs = pgTable("anti_nuke_guild_configs", {
  guildId: text("guild_id").primaryKey(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const antiNukeIncidents = pgTable(
  "anti_nuke_incidents",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    eventKey: text("event_key"),
    detector: text("detector").notNull(),
    executorId: text("executor_id"),
    targetId: text("target_id"),
    action: text("action").notNull(),
    thresholdCount: integer("threshold_count").notNull().default(0),
    response: text("response").notNull(),
    outcome: text("outcome").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("anti_nuke_incidents_guild_event_unique_idx")
      .on(table.guildId, table.eventKey)
      .where(sql`${table.eventKey} is not null`),
    index("anti_nuke_incidents_guild_occurred_idx").on(
      table.guildId,
      table.occurredAt,
    ),
    index("anti_nuke_incidents_guild_executor_idx").on(
      table.guildId,
      table.executorId,
    ),
    index("anti_nuke_incidents_guild_target_idx").on(
      table.guildId,
      table.targetId,
    ),
  ],
);

export type AntiNukeGuildConfig = typeof antiNukeGuildConfigs.$inferSelect;
export type NewAntiNukeIncident = typeof antiNukeIncidents.$inferInsert;
export type AntiNukeIncidentRow = typeof antiNukeIncidents.$inferSelect;
