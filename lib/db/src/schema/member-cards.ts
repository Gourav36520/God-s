import {
  customType,
  index,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const memberCardSettings = pgTable("member_card_settings", {
  guildId: text("guild_id").primaryKey(),
  channelId: text("channel_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const memberCardMembers = pgTable(
  "member_card_members",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    departedAt: timestamp("departed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index("member_card_members_guild_departed_idx").on(
      table.guildId,
      table.departedAt,
    ),
  ],
);

export const memberCardMessages = pgTable(
  "member_card_messages",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    cardKind: text("card_kind").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.guildId, table.userId, table.cardKind],
    }),
    index("member_card_messages_channel_message_idx").on(
      table.channelId,
      table.messageId,
    ),
  ],
);

export const memberCardImages = pgTable(
  "member_card_images",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    cardKind: text("card_kind").notNull(),
    imageData: bytea("image_data").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.guildId, table.userId, table.cardKind],
    }),
    index("member_card_images_guild_user_idx").on(
      table.guildId,
      table.userId,
    ),
  ],
);

export const memberProfileChanges = pgTable(
  "member_profile_changes",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    field: text("field"),
    previousValue: text("previous_value"),
    newValue: text("new_value"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("member_profile_changes_guild_user_date_idx").on(
      table.guildId,
      table.userId,
      table.occurredAt,
    ),
  ],
);

export const insertMemberCardSettingsSchema = createInsertSchema(
  memberCardSettings,
).omit({ updatedAt: true });
export const insertMemberCardMemberSchema = createInsertSchema(
  memberCardMembers,
).omit({ createdAt: true });
export const insertMemberCardMessageSchema = createInsertSchema(
  memberCardMessages,
).omit({ updatedAt: true });
export const insertMemberCardImageSchema = createInsertSchema(
  memberCardImages,
).omit({ updatedAt: true });
export const insertMemberProfileChangeSchema = createInsertSchema(
  memberProfileChanges,
).omit({ id: true });

export type InsertMemberCardSettings = z.infer<
  typeof insertMemberCardSettingsSchema
>;
export type InsertMemberCardMember = z.infer<
  typeof insertMemberCardMemberSchema
>;
export type InsertMemberCardMessage = z.infer<
  typeof insertMemberCardMessageSchema
>;
export type InsertMemberCardImage = z.infer<
  typeof insertMemberCardImageSchema
>;
export type InsertMemberProfileChange = z.infer<
  typeof insertMemberProfileChangeSchema
>;
export type MemberCardSetting = typeof memberCardSettings.$inferSelect;
export type MemberCardMember = typeof memberCardMembers.$inferSelect;
export type MemberCardMessage = typeof memberCardMessages.$inferSelect;
export type MemberCardImage = typeof memberCardImages.$inferSelect;
export type MemberProfileChangeRow = typeof memberProfileChanges.$inferSelect;
