import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const moderationCases = pgTable(
  "moderation_cases",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    targetId: text("target_id").notNull(),
    moderatorId: text("moderator_id").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (table) => [
    index("moderation_cases_guild_target_created_idx").on(
      table.guildId,
      table.targetId,
      table.createdAt,
    ),
    index("moderation_cases_active_warnings_idx").on(
      table.guildId,
      table.targetId,
      table.action,
      table.resolvedAt,
    ),
  ],
);

export type ModerationCase = typeof moderationCases.$inferSelect;
export type NewModerationCase = typeof moderationCases.$inferInsert;
