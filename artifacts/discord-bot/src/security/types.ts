import type { LoggingConfig } from "../logging/types.js";

export type { LoggingConfig };

export type SecurityAction = "warn" | "mute" | "kick" | "ban" | "delete";
export type AntiSpamAction = "warn" | "timeout" | "judgment";
export type RaidAction = "kick" | "ban" | "lockdown";
export type ModuleKey =
  | "antiSpam"
  | "antiLink"
  | "antiInvite"
  | "antiRaid"
  | "godsJudgment";

export interface AntiSpamConfig {
  enabled: boolean;
  maxMessages: number;
  timeWindowMs: number;
  action: AntiSpamAction;
  timeoutDurationMs: number;
  warnThreshold: number;
  bypassRoles: string[];
  bypassUsers: string[];
}

export interface AntiLinkConfig {
  enabled: boolean;
  allowedDomains: string[];
  bypassRoles: string[];
  action: SecurityAction;
}

export interface AntiInviteConfig {
  enabled: boolean;
  bypassRoles: string[];
  action: SecurityAction;
}

export interface AntiRaidConfig {
  enabled: boolean;
  joinThreshold: number;
  joinWindowMs: number;
  action: RaidAction;
  lockdownDurationMs: number;
}

export interface JudgmentRecord {
  userId: string;
  savedRoles: string[];
  judgedAt: string;
  reason: string;
  judgedBy: string;
}

export interface GodsJudgmentConfig {
  enabled: boolean;
  logChannelId: string | null;
  dmOnAction: boolean;
  judgmentRoleId: string | null;
  judgmentChannelId: string | null;
  activeJudgments: Record<string, JudgmentRecord>;
}

export interface GuildSecurityConfig {
  guildId: string;
  logChannelId: string | null;
  muteRoleId: string | null;
  exemptRoles: string[];
  exemptChannels: string[];
  antiSpam: AntiSpamConfig;
  antiLink: AntiLinkConfig;
  antiInvite: AntiInviteConfig;
  antiRaid: AntiRaidConfig;
  godsJudgment: GodsJudgmentConfig;
  logging: LoggingConfig;
  updatedAt: string;
}

export interface SecurityActionResult {
  success: boolean;
  action: SecurityAction | RaidAction | null;
  reason: string;
  targetId?: string;
  guildId?: string;
}

export interface JudgmentResult {
  success: boolean;
  reason: string;
  record?: JudgmentRecord;
}
