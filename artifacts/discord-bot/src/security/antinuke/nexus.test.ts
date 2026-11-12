import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeterministicNexusProvider,
  createNexusAnalyzer,
  NexusBehaviorHistory,
  NEXUS_HISTORY_WINDOW_MS,
  type NexusAnalysisContext,
  type NexusProvider,
} from "./nexus.js";

const context: NexusAnalysisContext = {
  detector: "channel-delete",
  auditVerified: true,
  executorKind: "human",
  executorTrust: "unlisted",
  serverOwner: false,
  thresholdCount: 1,
  configuredLimit: 2,
  configuredWindowSeconds: 5,
  relatedEventCount: 2,
  distinctRelatedDetectors: 1,
  sameDetectorEventCount: 2,
};

test("returns an observe-only fallback when no provider is configured", async () => {
  const result = await createNexusAnalyzer().analyze(context);

  assert.equal(result.status, "unavailable");
  assert.equal(result.analysisMode, "unavailable");
  assert.equal(result.riskLevel, "unknown");
  assert.equal(result.recommendation, "observe");
  assert.equal("punishment" in result, false);
});

test("accepts bounded advisory output and discards extra provider fields", async () => {
  const provider: NexusProvider = {
    analysisMode: "ai",
    async analyze() {
      return {
        riskLevel: "high",
        riskScore: 82,
        confidence: 0.9,
        summary: "Several verified changes are approaching the configured limit.",
        reasons: ["Repeated channel deletion"],
        falsePositiveIndicators: ["No other detector activity"],
        recommendation: "owner-review",
        punishment: "ban",
      };
    },
  };

  const result = await createNexusAnalyzer(provider).analyze(context);

  assert.equal(result.status, "available");
  assert.equal(result.analysisMode, "ai");
  assert.equal(result.riskLevel, "high");
  assert.equal(result.recommendation, "owner-review");
  assert.equal("punishment" in result, false);
});

test("rejects provider output that attempts to recommend enforcement", async () => {
  const provider: NexusProvider = {
    analysisMode: "ai",
    async analyze() {
      return {
        riskLevel: "critical",
        riskScore: 100,
        confidence: 1,
        summary: "Take immediate action.",
        reasons: ["Repeated actions"],
        falsePositiveIndicators: [],
        recommendation: "ban",
      };
    },
  };

  const result = await createNexusAnalyzer(provider).analyze(context);

  assert.equal(result.status, "unavailable");
  assert.equal(result.recommendation, "observe");
});

test("returns the safe fallback when provider analysis fails", async () => {
  const provider: NexusProvider = {
    analysisMode: "ai",
    async analyze() {
      throw new Error("provider unavailable");
    },
  };

  const result = await createNexusAnalyzer(provider).analyze(context);

  assert.equal(result.status, "unavailable");
  assert.equal(result.recommendation, "observe");
});

test("aborts a timed-out provider and returns without waiting for it", async () => {
  let providerSignal: AbortSignal | undefined;
  const provider: NexusProvider = {
    analysisMode: "ai",
    analyze(_context, signal) {
      providerSignal = signal;
      return new Promise(() => {});
    },
  };

  const result = await createNexusAnalyzer(provider, 5).analyze(context);

  assert.equal(result.status, "unavailable");
  assert.equal(providerSignal?.aborted, true);
});

test("does not call the provider with an invalid threshold context", async () => {
  let called = false;
  const provider: NexusProvider = {
    analysisMode: "ai",
    async analyze() {
      called = true;
      return {};
    },
  };

  const result = await createNexusAnalyzer(provider).analyze({
    ...context,
    configuredLimit: 0,
  });

  assert.equal(called, false);
  assert.equal(result.status, "unavailable");
});

test("tracks bounded recent behavior per guild and executor", () => {
  const history = new NexusBehaviorHistory();
  const start = Date.now();

  history.record("guild-a", "executor-a", "channel-delete", new Date(start));
  const summary = history.record(
    "guild-a",
    "executor-a",
    "role-delete",
    new Date(start + 30_000),
  );
  const otherGuild = history.record(
    "guild-b",
    "executor-a",
    "channel-delete",
    new Date(start + 30_000),
  );
  const afterWindow = history.record(
    "guild-a",
    "executor-a",
    "channel-delete",
    new Date(start + 30_000 + NEXUS_HISTORY_WINDOW_MS + 1),
  );

  assert.deepEqual(summary, {
    relatedEventCount: 2,
    distinctRelatedDetectors: 2,
    sameDetectorEventCount: 1,
  });
  assert.deepEqual(otherGuild, {
    relatedEventCount: 1,
    distinctRelatedDetectors: 1,
    sameDetectorEventCount: 1,
  });
  assert.deepEqual(afterWindow, {
    relatedEventCount: 1,
    distinctRelatedDetectors: 1,
    sameDetectorEventCount: 1,
  });
});

test("flags slow repeated activity for observation without changing enforcement", async () => {
  const provider = createDeterministicNexusProvider();
  const result = await createNexusAnalyzer(provider).analyze({
    ...context,
    thresholdCount: 1,
    relatedEventCount: 2,
    distinctRelatedDetectors: 1,
    sameDetectorEventCount: 2,
  });

  assert.equal(result.riskScore, 50);
  assert.equal(result.riskLevel, "medium");
  assert.equal(result.recommendation, "observe");
  assert.match(result.reasons.join(" "), /2 verified channel-delete events/);
  assert.match(
    result.falsePositiveIndicators.join(" "),
    /configured burst threshold has not been reached/,
  );
  assert.equal("punishment" in result, false);
});

test("correlated slow activity can request owner review without enforcement", async () => {
  const provider = createDeterministicNexusProvider();
  const result = await createNexusAnalyzer(provider).analyze({
    ...context,
    thresholdCount: 1,
    relatedEventCount: 4,
    distinctRelatedDetectors: 2,
    sameDetectorEventCount: 4,
  });

  assert.equal(result.riskLevel, "critical");
  assert.equal(result.riskScore, 100);
  assert.equal(result.recommendation, "owner-review");
  assert.ok(result.reasons.length >= 2);
  assert.equal("punishment" in result, false);
});

test("does not score unverified, unknown, owner, or whitelisted activity", async () => {
  const provider = createDeterministicNexusProvider();
  const protectedContexts = [
    { ...context, auditVerified: false },
    { ...context, executorKind: "unknown" as const },
    { ...context, serverOwner: true },
    { ...context, executorTrust: "whitelisted" as const },
  ];

  for (const protectedContext of protectedContexts) {
    const result = await createNexusAnalyzer(provider).analyze({
      ...protectedContext,
      relatedEventCount: 6,
      distinctRelatedDetectors: 3,
      sameDetectorEventCount: 5,
    });

    assert.equal(result.riskScore, 0);
    assert.equal(result.recommendation, "observe");
  }
});
