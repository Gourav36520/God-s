import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const levelingMembers = pgTable(
  "leveling_members",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    totalXp: bigint("total_xp", { mode: "bigint" }).notNull().default(0n),
    recentXp: bigint("recent_xp", { mode: "bigint" }).notNull().default(0n),
    recentXpAt: timestamp("recent_xp_at", { withTimezone: true }),
    lastMessageXpAt: timestamp("last_message_xp_at", { withTimezone: true }),
    lastVoiceXpAt: timestamp("last_voice_xp_at", { withTimezone: true }),
    voiceXpDayKey: text("voice_xp_day_key"),
    voiceXpMinutes: integer("voice_xp_minutes").notNull().default(0),
    departedAt: timestamp("departed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index("leveling_members_guild_xp_idx").on(
      table.guildId,
      table.totalXp,
      table.userId,
    ),
    index("leveling_members_guild_departed_idx").on(
      table.guildId,
      table.departedAt,
    ),
  ],
);

export const levelingXpEvents = pgTable(
  "leveling_xp_events",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    source: text("source").notNull(),
    sourceKey: text("source_key").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("leveling_xp_events_source_unique_idx").on(
      table.guildId,
      table.userId,
      table.source,
      table.sourceKey,
    ),
    index("leveling_xp_events_guild_created_idx").on(
      table.guildId,
      table.createdAt,
    ),
  ],
);

export const levelingMessageSignatures = pgTable(
  "leveling_message_signatures",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    signature: text("signature").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.guildId, table.userId, table.signature],
    }),
    index("leveling_message_signatures_expiry_idx").on(table.expiresAt),
  ],
);

export const levelingGuildSettings = pgTable("leveling_guild_settings", {
  guildId: text("guild_id").primaryKey(),
  announcementChannelId: text("announcement_channel_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const levelingRoleRewards = pgTable(
  "leveling_role_rewards",
  {
    guildId: text("guild_id").notNull(),
    level: integer("level").notNull(),
    roleId: text("role_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.level] }),
    index("leveling_role_rewards_guild_role_idx").on(
      table.guildId,
      table.roleId,
    ),
  ],
);

export const levelingInviteRewards = pgTable(
  "leveling_invite_rewards",
  {
    guildId: text("guild_id").notNull(),
    inviteeId: text("invitee_id").notNull(),
    inviterId: text("inviter_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    awardedAt: timestamp("awarded_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.inviteeId] }),
    index("leveling_invite_rewards_due_idx").on(
      table.status,
      table.eligibleAt,
    ),
  ],
);

export type LevelingMember = typeof levelingMembers.$inferSelect;
export type LevelingXpEvent = typeof levelingXpEvents.$inferSelect;
export type LevelingGuildSettings = typeof levelingGuildSettings.$inferSelect;
export type LevelingRoleReward = typeof levelingRoleRewards.$inferSelect;
export type LevelingInviteReward = typeof levelingInviteRewards.$inferSelect;
