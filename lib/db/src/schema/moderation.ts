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

export const moderationBanExpirations = pgTable(
  "moderation_ban_expirations",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    targetId: text("target_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("moderation_ban_expirations_due_idx").on(
      table.resolvedAt,
      table.expiresAt,
      table.retryAt,
    ),
    index("moderation_ban_expirations_guild_target_idx").on(
      table.guildId,
      table.targetId,
      table.resolvedAt,
    ),
  ],
);

export const moderationRoleConfigs = pgTable("moderation_role_configs", {
  guildId: text("guild_id").primaryKey(),
  adminRoleId: text("admin_role_id"),
  managerRoleId: text("manager_role_id"),
  warnRoleId: text("warn_role_id"),
  timeoutRoleId: text("timeout_role_id"),
  staffRequestRoleId: text("staff_request_role_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModerationCase = typeof moderationCases.$inferSelect;
export type NewModerationCase = typeof moderationCases.$inferInsert;
export type ModerationBanExpiration =
  typeof moderationBanExpirations.$inferSelect;
export type NewModerationBanExpiration =
  typeof moderationBanExpirations.$inferInsert;
export type ModerationRoleConfig = typeof moderationRoleConfigs.$inferSelect;
export type NewModerationRoleConfig = typeof moderationRoleConfigs.$inferInsert;
export type ModerationRoleField =
  | "adminRoleId"
  | "managerRoleId"
  | "warnRoleId"
  | "timeoutRoleId"
  | "staffRequestRoleId";
