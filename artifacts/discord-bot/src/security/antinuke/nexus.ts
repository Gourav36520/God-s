import { ANTI_NUKE_DETECTORS } from "./types.js";
import type { AntiNukeDetector, TrustKind } from "./types.js";

export type NexusRiskLevel = "unknown" | "low" | "medium" | "high" | "critical";
export type NexusRecommendation = "observe" | "owner-review";
export type NexusAnalysisMode = "deterministic" | "ai" | "unavailable";
export type NexusExecutorTrust =
  | "unlisted"
  | "whitelisted"
  | "blacklisted"
  | "unknown";

export const NEXUS_HISTORY_WINDOW_MS = 15 * 60 * 1_000;

/**
 * Minimal, aggregated event context for advisory analysis.
 * Do not add Discord IDs, message content, or credentials to this provider boundary.
 */
export interface NexusAnalysisContext {
  readonly detector: AntiNukeDetector;
  readonly auditVerified: boolean;
  readonly executorKind: TrustKind;
  readonly executorTrust: NexusExecutorTrust;
  readonly serverOwner: boolean;
  readonly thresholdCount: number;
  readonly configuredLimit: number;
  readonly configuredWindowSeconds: number;
  readonly relatedEventCount: number;
  readonly distinctRelatedDetectors: number;
  readonly sameDetectorEventCount: number;
}

export interface NexusAssessment {
  readonly status: "available" | "unavailable";
  readonly analysisMode: NexusAnalysisMode;
  readonly riskLevel: NexusRiskLevel;
  readonly riskScore: number | null;
  readonly confidence: number;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly falsePositiveIndicators: readonly string[];
  readonly recommendation: NexusRecommendation;
}

/** A provider can assess risk, but receives no Discord or enforcement capability. */
export interface NexusProvider {
  readonly analysisMode: Exclude<NexusAnalysisMode, "unavailable">;
  analyze(
    context: Readonly<NexusAnalysisContext>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface NexusAnalyzer {
  analyze(context: Readonly<NexusAnalysisContext>): Promise<NexusAssessment>;
}

interface NexusHistoryEvent {
  readonly detector: AntiNukeDetector;
  readonly occurredAt: number;
}

export interface NexusBehaviorSummary {
  readonly relatedEventCount: number;
  readonly distinctRelatedDetectors: number;
  readonly sameDetectorEventCount: number;
}

const MAX_HISTORY_EVENTS_PER_EXECUTOR = 128;
const MAX_TRACKED_EXECUTORS = 5_000;

/** Keeps a short, process-local history. Raw IDs never reach a provider. */
export class NexusBehaviorHistory {
  private readonly eventsByExecutor = new Map<string, NexusHistoryEvent[]>();

  record(
    guildId: string,
    executorId: string,
    detector: AntiNukeDetector,
    occurredAt: Date,
  ): NexusBehaviorSummary {
    const timestamp = occurredAt.getTime();
    if (
      !guildId ||
      !executorId ||
      !ANTI_NUKE_DETECTORS.includes(detector) ||
      !Number.isFinite(timestamp)
    ) {
      throw new Error("NEXUS history requires a verified executor event.");
    }

    const key = JSON.stringify([guildId, executorId]);
    const cutoff = timestamp - NEXUS_HISTORY_WINDOW_MS;
    const recent = (this.eventsByExecutor.get(key) ?? []).filter(
      (event) => event.occurredAt >= cutoff,
    );
    recent.push({ detector, occurredAt: timestamp });
    recent.sort((left, right) => left.occurredAt - right.occurredAt);
    if (recent.length > MAX_HISTORY_EVENTS_PER_EXECUTOR) {
      recent.splice(0, recent.length - MAX_HISTORY_EVENTS_PER_EXECUTOR);
    }

    this.eventsByExecutor.delete(key);
    this.eventsByExecutor.set(key, recent);
    while (this.eventsByExecutor.size > MAX_TRACKED_EXECUTORS) {
      const oldestKey = this.eventsByExecutor.keys().next().value;
      if (oldestKey === undefined) break;
      this.eventsByExecutor.delete(oldestKey);
    }

    const relevant = recent.filter((event) => event.occurredAt <= timestamp);
    return {
      relatedEventCount: relevant.length,
      distinctRelatedDetectors: new Set(
        relevant.map((event) => event.detector),
      ).size,
      sameDetectorEventCount: relevant.filter(
        (event) => event.detector === detector,
      ).length,
    };
  }
}

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 5_000;
const MAX_SUMMARY_LENGTH = 280;
const MAX_SIGNAL_LENGTH = 160;
const MAX_SIGNALS = 5;

/**
 * Creates an advisory-only analysis boundary. Without a provider, on invalid
 * input, on malformed output, or on provider failure, it returns a safe
 * unavailable assessment. It never changes Anti-Nuke enforcement.
 */
export function createNexusAnalyzer(
  provider?: NexusProvider,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): NexusAnalyzer {
  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  return {
    async analyze(context) {
      if (!provider || !isValidContext(context)) {
        return unavailableAssessment();
      }

      const controller = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(new Error("NEXUS analysis timed out."));
          }, boundedTimeoutMs);
        });
        const result = await Promise.race([
          provider.analyze(Object.freeze({ ...context }), controller.signal),
          timeout,
        ]);

        return (
          normalizeAssessment(result, provider.analysisMode) ??
          unavailableAssessment()
        );
      } catch {
        return unavailableAssessment();
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        controller.abort();
      }
    },
  };
}

function isValidContext(context: NexusAnalysisContext): boolean {
  if (!context || typeof context !== "object") return false;

  return (
    ANTI_NUKE_DETECTORS.includes(context.detector) &&
    typeof context.auditVerified === "boolean" &&
    ["human", "bot", "unknown"].includes(context.executorKind) &&
    ["unlisted", "whitelisted", "blacklisted", "unknown"].includes(
      context.executorTrust,
    ) &&
    typeof context.serverOwner === "boolean" &&
    isNonNegativeInteger(context.thresholdCount) &&
    isPositiveInteger(context.configuredLimit) &&
    isPositiveInteger(context.configuredWindowSeconds) &&
    isNonNegativeInteger(context.relatedEventCount) &&
    isNonNegativeInteger(context.distinctRelatedDetectors) &&
    isNonNegativeInteger(context.sameDetectorEventCount) &&
    context.sameDetectorEventCount <= context.relatedEventCount &&
    context.distinctRelatedDetectors <= context.relatedEventCount
  );
}

function normalizeAssessment(
  value: unknown,
  analysisMode: Exclude<NexusAnalysisMode, "unavailable">,
): NexusAssessment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const riskLevels: readonly NexusRiskLevel[] = [
    "unknown",
    "low",
    "medium",
    "high",
    "critical",
  ];
  const recommendations: readonly NexusRecommendation[] = [
    "observe",
    "owner-review",
  ];

  if (
    !riskLevels.includes(candidate.riskLevel as NexusRiskLevel) ||
    !recommendations.includes(candidate.recommendation as NexusRecommendation) ||
    typeof candidate.summary !== "string" ||
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1 ||
    !isStringArray(candidate.reasons) ||
    !isStringArray(candidate.falsePositiveIndicators) ||
    !(
      candidate.riskScore === null ||
      (typeof candidate.riskScore === "number" &&
        Number.isInteger(candidate.riskScore) &&
        candidate.riskScore >= 0 &&
        candidate.riskScore <= 100)
    )
  ) {
    return null;
  }

  return {
    status: "available",
    analysisMode,
    riskLevel: candidate.riskLevel as NexusRiskLevel,
    riskScore: candidate.riskScore as number | null,
    confidence: candidate.confidence,
    summary: candidate.summary.trim().slice(0, MAX_SUMMARY_LENGTH),
    reasons: candidate.reasons
      .slice(0, MAX_SIGNALS)
      .map((reason) => reason.trim().slice(0, MAX_SIGNAL_LENGTH)),
    falsePositiveIndicators: candidate.falsePositiveIndicators
      .slice(0, MAX_SIGNALS)
      .map((indicator) => indicator.trim().slice(0, MAX_SIGNAL_LENGTH)),
    recommendation: candidate.recommendation as NexusRecommendation,
  };
}

/** Explainable, provider-free behavior scoring; it has no enforcement path. */
export function createDeterministicNexusProvider(): NexusProvider {
  return {
    analysisMode: "deterministic",
    async analyze(context) {
      const reasons: string[] = [];
      const falsePositiveIndicators: string[] = [];
      let riskScore = 0;

      if (!context.auditVerified) {
        falsePositiveIndicators.push(
          "The activity was not audit-verified; no risk inference was made.",
        );
      } else if (context.serverOwner) {
        falsePositiveIndicators.push(
          "The server owner is excluded from NEXUS risk recommendations.",
        );
      } else if (context.executorKind === "unknown") {
        falsePositiveIndicators.push(
          "The executor type is unknown; no risk inference was made.",
        );
      } else if (context.executorTrust === "whitelisted") {
        falsePositiveIndicators.push(
          "The executor is whitelisted; existing trust precedence remains authoritative.",
        );
      } else {
        if (
          context.sameDetectorEventCount >= 2 &&
          context.thresholdCount < context.configuredLimit
        ) {
          riskScore += 35;
          reasons.push(
            `${context.sameDetectorEventCount} verified ${context.detector} events occurred within 15 minutes without reaching the ${context.configuredLimit}-event threshold in ${context.configuredWindowSeconds} seconds.`,
          );
        }
        if (
          context.sameDetectorEventCount >= 4 &&
          context.thresholdCount < context.configuredLimit
        ) {
          riskScore += 25;
          reasons.push(
            "The repeated activity continued across multiple configured threshold windows.",
          );
        }
        if (
          context.relatedEventCount >= 3 &&
          context.distinctRelatedDetectors >= 2
        ) {
          riskScore += 35;
          reasons.push(
            `${context.relatedEventCount} verified events span ${context.distinctRelatedDetectors} detector types within 15 minutes.`,
          );
        }
        if (
          context.relatedEventCount >= 2 &&
          context.thresholdCount >= context.configuredLimit - 1 &&
          context.thresholdCount < context.configuredLimit
        ) {
          riskScore += 15;
          reasons.push(
            "Recent activity is one event below the configured burst threshold.",
          );
        }
        if (context.executorTrust === "blacklisted" && riskScore > 0) {
          riskScore += 10;
          reasons.push(
            "The existing server blacklist identifies this executor for additional owner attention.",
          );
        }

        if (context.thresholdCount < context.configuredLimit) {
          falsePositiveIndicators.push(
            "The configured burst threshold has not been reached; review the pattern before taking action.",
          );
        }
        if (context.distinctRelatedDetectors < 2) {
          falsePositiveIndicators.push(
            "Activity is limited to one detector and may reflect routine server maintenance.",
          );
        }
        if (context.executorKind === "bot") {
          falsePositiveIndicators.push(
            "Automations and integrations can produce repeated verified changes.",
          );
        }
        if (context.executorKind === "human") {
          falsePositiveIndicators.push(
            "Routine administrator maintenance can produce repeated verified changes.",
          );
        }
      }

      riskScore = Math.min(100, riskScore);
      const riskLevel: NexusRiskLevel =
        riskScore >= 85
          ? "critical"
          : riskScore >= 60
            ? "high"
            : riskScore >= 35
              ? "medium"
              : "low";
      const recommendation: NexusRecommendation =
        riskScore >= 60 ? "owner-review" : "observe";
      const confidence =
        riskScore === 0
          ? 0.25
          : Math.min(0.9, 0.4 + context.relatedEventCount * 0.08);
      const summary =
        recommendation === "owner-review"
          ? "Verified activity forms a repeated or cross-detector pattern. Review it manually; NEXUS cannot take action."
          : reasons.length > 0
            ? "Verified activity shows a pattern to observe; deterministic Anti-Nuke rules remain authoritative."
            : "No repeated or cross-detector risk pattern was identified.";

      return {
        riskLevel,
        riskScore,
        confidence,
        summary,
        reasons,
        falsePositiveIndicators,
        recommendation,
      };
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SIGNALS &&
    value.every((item) => typeof item === "string")
  );
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function unavailableAssessment(): NexusAssessment {
  return {
    status: "unavailable",
    analysisMode: "unavailable",
    riskLevel: "unknown",
    riskScore: null,
    confidence: 0,
    summary: "NEXUS analysis is unavailable; Anti-Nuke continues unchanged.",
    reasons: [],
    falsePositiveIndicators: [],
    recommendation: "observe",
  };
}
