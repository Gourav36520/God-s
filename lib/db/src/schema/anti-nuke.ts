import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const antiNukeGuildConfigTable = pgTable(
  "anti_nuke_guild_config",
  {
    guildId: text("guild_id").primaryKey(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const antiNukeIncidentsTable = pgTable(
  "anti_nuke_incidents",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    eventKey: text("event_key"),
    detector: text("detector").notNull(),
    executorId: text("executor_id"),
    targetId: text("target_id"),
    action: text("action").notNull(),
    thresholdCount: integer("threshold_count").notNull(),
    response: text("response").notNull(),
    outcome: text("outcome").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("anti_nuke_incidents_guild_event_uq").on(
      table.guildId,
      table.eventKey,
    ),
    index("anti_nuke_incidents_guild_time_idx").on(
      table.guildId,
      table.occurredAt,
    ),
    index("anti_nuke_incidents_guild_detector_time_idx").on(
      table.guildId,
      table.detector,
      table.occurredAt,
    ),
  ],
);
