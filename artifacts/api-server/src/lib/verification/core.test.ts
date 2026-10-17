import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOAuthIdentity,
  hashSecret,
  isExpired,
  optionalEmail,
  validateOAuthState,
  validateTurnstileAssessment,
} from "./core";
import { getVerificationConfig } from "./config";

const NOW = new Date("2026-10-17T00:00:00.000Z");

test("OAuth account mismatch is rejected", () => {
  assert.throws(
    () => assertOAuthIdentity("100000000000000001", "100000000000000002"),
    /OAUTH_ACCOUNT_MISMATCH/,
  );
  assert.doesNotThrow(() =>
    assertOAuthIdentity("100000000000000001", "100000000000000001"),
  );
});

test("invalid, expired, and reused OAuth state is rejected", () => {
  const state = "one-time-random-state";
  const record = {
    stateHash: hashSecret(state),
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
  };

  assert.equal(validateOAuthState(record, state, "different-state", NOW), false);
  assert.equal(validateOAuthState(record, "wrong-state", state, NOW), false);
  assert.equal(
    validateOAuthState(
      { ...record, expiresAt: new Date(NOW.getTime() - 1) },
      state,
      state,
      NOW,
    ),
    false,
  );
  assert.equal(
    validateOAuthState({ ...record, consumedAt: NOW }, state, state, NOW),
    false,
  );
  assert.equal(validateOAuthState(record, state, state, NOW), true);
});

test("expired verification sessions are recognized", () => {
  assert.equal(isExpired(new Date(NOW.getTime() - 1), NOW), true);
  assert.equal(isExpired(new Date(NOW.getTime() + 1), NOW), false);
});

test("Turnstile rejects failed, wrong-host, wrong-action, and stale assessments", () => {
  const fresh = {
    success: true,
    hostname: "verify.example.test",
    action: "verify",
    challenge_ts: new Date(NOW.getTime() - 20_000).toISOString(),
  };
  assert.equal(
    validateTurnstileAssessment(
      { ...fresh, success: false },
      "verify.example.test",
      "verify",
      NOW,
    ),
    false,
  );
  assert.equal(
    validateTurnstileAssessment(
      { ...fresh, hostname: "attacker.example.test" },
      "verify.example.test",
      "verify",
      NOW,
    ),
    false,
  );
  assert.equal(
    validateTurnstileAssessment(
      { ...fresh, action: "other" },
      "verify.example.test",
      "verify",
      NOW,
    ),
    false,
  );
  assert.equal(
    validateTurnstileAssessment(
      {
        ...fresh,
        challenge_ts: new Date(NOW.getTime() - 6 * 60_000).toISOString(),
      },
      "verify.example.test",
      "verify",
      NOW,
    ),
    false,
  );
  assert.equal(
    validateTurnstileAssessment(
      { ...fresh, challenge_ts: "not-a-date" },
      "verify.example.test",
      "verify",
      NOW,
    ),
    false,
  );
});

test("missing or invalid Discord email remains null", () => {
  assert.equal(optionalEmail(undefined), null);
  assert.equal(optionalEmail(null), null);
  assert.equal(optionalEmail(""), null);
  assert.equal(optionalEmail("not-an-email"), null);
  assert.equal(optionalEmail("person@example.test"), "person@example.test");
});

test("verification fails closed when required deployment config is missing", () => {
  assert.throws(() => getVerificationConfig({}), /Verification is not configured/);
});
