export type LogCategory =
  | "moderation"
  | "messages"
  | "members"
  | "channels"
  | "roles"
  | "security";

export const LOG_CATEGORY_LABELS: Record<LogCategory, string> = {
  moderation: "Moderation",
  messages: "Messages",
  members: "Members",
  channels: "Channels",
  roles: "Roles",
  security: "Security",
};

export const ALL_CATEGORIES: LogCategory[] = [
  "moderation",
  "messages",
  "members",
  "channels",
  "roles",
  "security",
];

export interface LoggingConfig {
  channelId: string | null;
  channelIds: Partial<Record<LogCategory, string>>;
  categories: Record<LogCategory, boolean>;
}
