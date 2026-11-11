import { ANTI_NUKE_DETECTORS } from "./types.js";
import type { AntiNukeDetector, TrustKind } from "./types.js";

export type NexusRiskLevel = "unknown" | "low" | "medium" | "high" | "critical";
export type NexusRecommendation = "observe" | "owner-review";
export type NexusExecutorTrust =
  | "unlisted"
  | "whitelisted"
  | "blacklisted"
  | "unknown";

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
}

export interface NexusAssessment {
  readonly status: "available" | "unavailable";
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
  analyze(
    context: Readonly<NexusAnalysisContext>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface NexusAnalyzer {
  analyze(context: Readonly<NexusAnalysisContext>): Promise<NexusAssessment>;
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

        return normalizeAssessment(result) ?? unavailableAssessment();
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
    isNonNegativeInteger(context.distinctRelatedDetectors)
  );
}

function normalizeAssessment(value: unknown): NexusAssessment | null {
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
    riskLevel: "unknown",
    riskScore: null,
    confidence: 0,
    summary: "NEXUS analysis is unavailable; Anti-Nuke continues unchanged.",
    reasons: [],
    falsePositiveIndicators: [],
    recommendation: "observe",
  };
}
