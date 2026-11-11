import assert from "node:assert/strict";
import test from "node:test";
import {
  createNexusAnalyzer,
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
};

test("returns an observe-only fallback when no provider is configured", async () => {
  const result = await createNexusAnalyzer().analyze(context);

  assert.equal(result.status, "unavailable");
  assert.equal(result.riskLevel, "unknown");
  assert.equal(result.recommendation, "observe");
  assert.equal("punishment" in result, false);
});

test("accepts bounded advisory output and discards extra provider fields", async () => {
  const provider: NexusProvider = {
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
  assert.equal(result.riskLevel, "high");
  assert.equal(result.recommendation, "owner-review");
  assert.equal("punishment" in result, false);
});

test("rejects provider output that attempts to recommend enforcement", async () => {
  const provider: NexusProvider = {
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
