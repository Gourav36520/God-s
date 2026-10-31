export const ANTI_NUKE_DETECTORS = [
  "channel-create",
  "channel-delete",
  "channel-update",
  "member-kick",
  "member-ban",
  "role-create",
  "role-delete",
  "role-update",
  "role-permissions",
  "mass-role-add",
  "mass-role-remove",
  "webhook-create",
  "webhook-delete",
  "webhook-update",
  "integration-change",
  "bot-add",
  "guild-update",
  "emoji-sticker-change",
  "invite-create",
  "invite-delete",
] as const;

export type AntiNukeDetector = (typeof ANTI_NUKE_DETECTORS)[number];
export type AntiNukeResponse = "log" | "judgement" | "kick" | "lockdown";
export type JoinResponse = "log" | "judgement" | "kick";
export type TrustKind = "human" | "bot" | "unknown";

export interface DetectorConfig {
  enabled: boolean;
  limit: number;
  windowSeconds: number;
  responseMode: AntiNukeResponse | null;
}

export interface TrustEntry {
  id: string;
  kind: TrustKind;
  addedBy: string;
  addedAt: string;
}

export interface LockdownSnapshot {
  channelId: string;
  hadOverwrite: boolean;
  previousAllow: string;
  previousDeny: string;
  appliedAllow: string;
  appliedDeny: string;
  changedAt: string;
}

export interface AntiNukeConfig {
  enabled: boolean;
  detectors: Record<AntiNukeDetector, DetectorConfig>;
  whitelist: Record<string, TrustEntry>;
  blacklist: Record<string, TrustEntry>;
  unverifiedBotKick: boolean;
  blacklistedHumanJoinResponse: JoinResponse;
  judgementRoleId: string | null;
  logs: {
    categoryId: string | null;
    channelId: string | null;
    alertsEnabled: boolean;
    mentionOwner: boolean;
  };
  lockdown: {
    enabled: boolean;
    targets: string[];
    snapshots: LockdownSnapshot[];
  };
}

export interface AntiNukeIncident {
  id: string;
  guildId: string;
  eventKey: string | null;
  detector: AntiNukeDetector | "system";
  executorId: string | null;
  targetId: string | null;
  action: string;
  thresholdCount: number;
  response: string;
  outcome: string;
  details: Record<string, unknown>;
  occurredAt: Date;
}

export interface IncidentFilters {
  executorId?: string;
  targetId?: string;
  detector?: string;
}
