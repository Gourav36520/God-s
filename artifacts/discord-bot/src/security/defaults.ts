import type { GuildSecurityConfig } from "./types.js";
import { ALL_CATEGORIES } from "../logging/types.js";

export function buildDefaultConfig(guildId: string): GuildSecurityConfig {
  return {
    guildId,
    logChannelId: null,
    muteRoleId: null,
    exemptRoles: [],
    exemptChannels: [],
    antiSpam: {
      enabled: false,
      maxMessages: 5,
      timeWindowMs: 5_000,
      action: "warn",
      timeoutDurationMs: 5 * 60 * 1_000,
      warnThreshold: 3,
      bypassRoles: [],
      bypassUsers: [],
    },
    antiLink: {
      enabled: false,
      allowedDomains: [],
      bypassRoles: [],
      action: "delete",
    },
    antiInvite: {
      enabled: false,
      bypassRoles: [],
      action: "delete",
    },
    antiRaid: {
      enabled: false,
      joinThreshold: 10,
      joinWindowMs: 10_000,
      action: "kick",
      lockdownDurationMs: 5 * 60 * 1_000,
    },
    godsJudgment: {
      enabled: false,
      logChannelId: null,
      dmOnAction: true,
      judgmentRoleId: null,
      judgmentChannelId: null,
      activeJudgments: {},
    },
    logging: {
      channelId: null,
      categories: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, false])) as Record<
        typeof ALL_CATEGORIES[number],
        boolean
      >,
    },
    updatedAt: new Date().toISOString(),
  };
}
