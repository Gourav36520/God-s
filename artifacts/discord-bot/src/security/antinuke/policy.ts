import {
  ANTI_NUKE_DETECTORS,
  type AntiNukeConfig,
  type AntiNukeDetector,
  type AntiNukeResponse,
  type TrustKind,
} from "./types.js";

const REQUIRED_DETECTORS = new Set<AntiNukeDetector>([
  "channel-create",
  "channel-delete",
  "member-kick",
  "member-ban",
]);
const WEBHOOK_DETECTORS = new Set<AntiNukeDetector>([
  "webhook-create",
  "webhook-delete",
  "webhook-update",
]);

export function resolveTrust(
  config: AntiNukeConfig,
  id: string,
): "blacklisted" | "whitelisted" | "unapproved" {
  if (Object.hasOwn(config.blacklist, id)) return "blacklisted";
  if (Object.hasOwn(config.whitelist, id)) return "whitelisted";
  return "unapproved";
}

export function resolveDefaultResponse(
  detector: AntiNukeDetector,
  executorKind: TrustKind,
  configured: AntiNukeResponse | null,
): AntiNukeResponse {
  if (executorKind === "unknown") return "log";
  if (configured) return configured;
  if (REQUIRED_DETECTORS.has(detector)) {
    return executorKind === "bot" ? "kick" : "judgement";
  }
  return "log";
}

export function isGuildOwner(actorId: string, guildOwnerId: string): boolean {
  return actorId === guildOwnerId;
}

export function isWebhookDetector(detector: AntiNukeDetector): boolean {
  return WEBHOOK_DETECTORS.has(detector);
}

export function thresholdForDetector(
  detector: AntiNukeDetector,
  configuredLimit: number,
): number {
  return isWebhookDetector(detector)
    ? Math.max(2, configuredLimit)
    : configuredLimit;
}

export function isConfirmedWebhookRaid(
  detector: AntiNukeDetector,
  eventCount: number,
  configuredLimit: number,
): boolean {
  return (
    isWebhookDetector(detector) &&
    Number.isInteger(eventCount) &&
    eventCount >= thresholdForDetector(detector, configuredLimit)
  );
}

export function resolveIncidentResponse(
  detector: AntiNukeDetector,
  executorKind: TrustKind,
  configured: AntiNukeResponse | null,
  confirmedWebhookRaid = false,
): AntiNukeResponse {
  if (executorKind === "unknown") return "log";
  if (isWebhookDetector(detector) && confirmedWebhookRaid) {
    return executorKind === "bot" ? "kick" : "judgement";
  }

  // Existing saved lockdown response values remain readable, but incidents
  // must never turn them into an automatic channel lockdown.
  return resolveDefaultResponse(
    detector,
    executorKind,
    configured === "lockdown" ? null : configured,
  );
}

export function resolveJoinPolicy(
  config: AntiNukeConfig,
  id: string,
  isBot: boolean,
): "kick" | "judgement" | "log" {
  const trust = resolveTrust(config, id);
  if (isBot) {
    if (trust === "blacklisted" || (trust === "unapproved" && config.unverifiedBotKick)) {
      return "kick";
    }
    return "log";
  }
  return trust === "blacklisted" ? config.blacklistedHumanJoinResponse : "log";
}

export function isManualJudgementOwner(actorId: string, guildOwnerId: string): boolean {
  return actorId === guildOwnerId;
}

export function isAntiNukeDetector(value: string): value is AntiNukeDetector {
  return (ANTI_NUKE_DETECTORS as readonly string[]).includes(value);
}

export class EventDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 60_000) {}

  claim(key: string, now = Date.now()): boolean {
    for (const [existing, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(existing);
    }
    if ((this.seen.get(key) ?? 0) > now) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }
}

export class PunishmentGate {
  private readonly active = new Map<string, number>();

  claim(key: string, now: number, cooldownMs: number): boolean {
    for (const [existing, expiresAt] of this.active) {
      if (expiresAt <= now) this.active.delete(existing);
    }
    if ((this.active.get(key) ?? 0) > now) return false;
    this.active.set(key, now + cooldownMs);
    if (this.active.size > 10_000) {
      const oldest = this.active.keys().next().value;
      if (oldest) this.active.delete(oldest);
    }
    return true;
  }
}

export class RollingThresholdCounter {
  private readonly events = new Map<string, number[]>();

  add(
    guildId: string,
    executorId: string,
    detector: AntiNukeDetector,
    now: number,
    windowMs: number,
  ): number {
    const key = JSON.stringify([guildId, executorId, detector]);
    const recent = (this.events.get(key) ?? []).filter(
      (timestamp) => timestamp > now - windowMs,
    );
    recent.push(now);
    this.events.delete(key);
    this.events.set(key, recent);
    if (this.events.size > 10_000) {
      const oldest = this.events.keys().next().value;
      if (oldest) this.events.delete(oldest);
    }
    return recent.length;
  }

  count(
    guildId: string,
    executorId: string,
    detector: AntiNukeDetector,
    now: number,
    windowMs: number,
  ): number {
    const key = JSON.stringify([guildId, executorId, detector]);
    const recent = (this.events.get(key) ?? []).filter(
      (timestamp) => timestamp > now - windowMs,
    );
    this.events.set(key, recent);
    return recent.length;
  }

  clear(): void {
    this.events.clear();
  }
}
