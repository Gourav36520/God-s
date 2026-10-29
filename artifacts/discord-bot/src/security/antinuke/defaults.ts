import {
  ANTI_NUKE_DETECTORS,
  type AntiNukeConfig,
  type AntiNukeDetector,
  type AntiNukeResponse,
  type DetectorConfig,
  type TrustEntry,
} from "./types.js";

const REQUIRED_DEFAULTS: Record<
  Extract<
    AntiNukeDetector,
    "channel-create" | "channel-delete" | "member-kick" | "member-ban"
  >,
  { limit: number; windowSeconds: number }
> = {
  "channel-create": { limit: 3, windowSeconds: 3 },
  "channel-delete": { limit: 3, windowSeconds: 3 },
  "member-kick": { limit: 3, windowSeconds: 5 },
  "member-ban": { limit: 3, windowSeconds: 5 },
};

const VALID_RESPONSES: AntiNukeResponse[] = [
  "log",
  "judgement",
  "kick",
  "lockdown",
];

export function createDefaultAntiNukeConfig(): AntiNukeConfig {
  const detectors = Object.fromEntries(
    ANTI_NUKE_DETECTORS.map((name) => [
      name,
      {
        enabled: false,
        limit: 5,
        windowSeconds: 10,
        responseMode: null,
      } satisfies DetectorConfig,
    ]),
  ) as Record<AntiNukeDetector, DetectorConfig>;

  for (const [name, threshold] of Object.entries(REQUIRED_DEFAULTS) as [
    keyof typeof REQUIRED_DEFAULTS,
    (typeof REQUIRED_DEFAULTS)[keyof typeof REQUIRED_DEFAULTS],
  ][]) {
    detectors[name] = {
      enabled: true,
      ...threshold,
      responseMode: null,
    };
  }

  return {
    enabled: true,
    dryRun: false,
    detectors,
    whitelist: {},
    blacklist: {},
    unverifiedBotKick: false,
    blacklistedHumanJoinResponse: "log",
    judgementRoleId: null,
    logs: {
      categoryId: null,
      channelId: null,
      alertsEnabled: true,
      mentionOwner: false,
    },
    lockdown: {
      enabled: false,
      targets: [],
      snapshots: [],
    },
  };
}

export function normalizeAntiNukeConfig(raw: unknown): AntiNukeConfig {
  const defaults = createDefaultAntiNukeConfig();
  if (!raw || typeof raw !== "object") return defaults;

  const value = raw as Partial<AntiNukeConfig>;
  const rawDetectors = value.detectors as
    | Partial<Record<AntiNukeDetector, Partial<DetectorConfig>>>
    | undefined;

  const detectors = Object.fromEntries(
    ANTI_NUKE_DETECTORS.map((name) => {
      const stored = rawDetectors?.[name];
      const limit = finiteInteger(stored?.limit, defaults.detectors[name].limit, 1, 100);
      const windowSeconds = finiteInteger(
        stored?.windowSeconds,
        defaults.detectors[name].windowSeconds,
        1,
        3600,
      );
      const responseMode =
        stored?.responseMode === null ||
        VALID_RESPONSES.includes(stored?.responseMode as AntiNukeResponse)
          ? (stored?.responseMode ?? null)
          : defaults.detectors[name].responseMode;
      return [
        name,
        {
          enabled: typeof stored?.enabled === "boolean"
            ? stored.enabled
            : defaults.detectors[name].enabled,
          limit,
          windowSeconds,
          responseMode,
        },
      ];
    }),
  ) as Record<AntiNukeDetector, DetectorConfig>;

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    dryRun: typeof value.dryRun === "boolean" ? value.dryRun : defaults.dryRun,
    detectors,
    whitelist: trustMap(value.whitelist),
    blacklist: trustMap(value.blacklist),
    unverifiedBotKick:
      typeof value.unverifiedBotKick === "boolean"
        ? value.unverifiedBotKick
        : defaults.unverifiedBotKick,
    blacklistedHumanJoinResponse:
      value.blacklistedHumanJoinResponse === "kick" ||
      value.blacklistedHumanJoinResponse === "judgement"
        ? value.blacklistedHumanJoinResponse
        : "log",
    judgementRoleId:
      typeof value.judgementRoleId === "string" ? value.judgementRoleId : null,
    logs: {
      categoryId:
        typeof value.logs?.categoryId === "string" ? value.logs.categoryId : null,
      channelId:
        typeof value.logs?.channelId === "string" ? value.logs.channelId : null,
      alertsEnabled:
        typeof value.logs?.alertsEnabled === "boolean"
          ? value.logs.alertsEnabled
          : defaults.logs.alertsEnabled,
      mentionOwner:
        typeof value.logs?.mentionOwner === "boolean"
          ? value.logs.mentionOwner
          : defaults.logs.mentionOwner,
    },
    lockdown: {
      enabled:
        typeof value.lockdown?.enabled === "boolean"
          ? value.lockdown.enabled
          : false,
      targets: Array.isArray(value.lockdown?.targets)
        ? value.lockdown.targets.filter((id): id is string => typeof id === "string")
        : [],
      snapshots: Array.isArray(value.lockdown?.snapshots)
        ? value.lockdown.snapshots.filter(isLockdownSnapshot)
        : [],
    },
  };
}

function trustMap(value: unknown): Record<string, TrustEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, TrustEntry> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const stored = entry as Partial<TrustEntry>;
    result[id] = {
      id,
      kind:
        stored.kind === "human" || stored.kind === "bot"
          ? stored.kind
          : "unknown",
      addedBy: typeof stored.addedBy === "string" ? stored.addedBy : "unknown",
      addedAt:
        typeof stored.addedAt === "string"
          ? stored.addedAt
          : new Date(0).toISOString(),
    };
  }
  return result;
}

function isLockdownSnapshot(value: unknown): value is AntiNukeConfig["lockdown"]["snapshots"][number] {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.channelId === "string" &&
    typeof row.hadOverwrite === "boolean" &&
    typeof row.previousAllow === "string" &&
    typeof row.previousDeny === "string" &&
    typeof row.appliedAllow === "string" &&
    typeof row.appliedDeny === "string" &&
    typeof row.changedAt === "string"
  );
}

function finiteInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}
