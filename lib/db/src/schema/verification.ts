import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const verificationSessionsTable = pgTable(
  "verification_sessions",
  {
    sessionHash: text("session_hash").primaryKey(),
    userId: text("user_id").notNull(),
    guildId: text("guild_id").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    csrfTokenHash: text("csrf_token_hash"),
    oauthStateHash: text("oauth_state_hash"),
    oauthStateExpiresAt: timestamp("oauth_state_expires_at", {
      withTimezone: true,
    }),
    oauthStateConsumedAt: timestamp("oauth_state_consumed_at", {
      withTimezone: true,
    }),
    turnstileTokenHash: text("turnstile_token_hash"),
    usernameSnapshot: text("username_snapshot"),
    emailEncrypted: text("email_encrypted"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    eventId: text("event_id"),
    privateLogDeliveredAt: timestamp("private_log_delivered_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("verification_sessions_oauth_state_hash_uq").on(
      table.oauthStateHash,
    ),
    uniqueIndex("verification_sessions_turnstile_token_hash_uq").on(
      table.turnstileTokenHash,
    ),
    uniqueIndex("verification_sessions_event_id_uq").on(table.eventId),
  ],
);

export const verificationBotNoncesTable = pgTable("verification_bot_nonces", {
  nonceHash: text("nonce_hash").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
