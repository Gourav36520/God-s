import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAntiNukeConfig } from "./defaults.js";
import {
  EventDeduplicator,
  isManualJudgementOwner,
  PunishmentGate,
  resolveDefaultResponse,
  resolveJoinPolicy,
  resolveTrust,
  RollingThresholdCounter,
} from "./policy.js";

test("mandatory detector defaults remain exact and independent", () => {
  const config = createDefaultAntiNukeConfig();
  assert.deepEqual(
    [
      config.detectors["channel-delete"],
      config.detectors["channel-create"],
      config.detectors["member-kick"],
      config.detectors["member-ban"],
    ].map(({ enabled, limit, windowSeconds }) => ({ enabled, limit, windowSeconds })),
    [
      { enabled: true, limit: 3, windowSeconds: 3 },
      { enabled: true, limit: 3, windowSeconds: 3 },
      { enabled: true, limit: 3, windowSeconds: 5 },
      { enabled: true, limit: 3, windowSeconds: 5 },
    ],
  );
  assert.equal(config.detectors["webhook-create"].enabled, false);
  assert.equal(config.detectors["bot-add"].enabled, false);
});

test("rolling counts separate guild, executor, and action type", () => {
  const counter = new RollingThresholdCounter();
  assert.equal(counter.add("g1", "u1", "channel-create", 1_000, 3_000), 1);
  assert.equal(counter.add("g1", "u2", "channel-create", 1_100, 3_000), 1);
  assert.equal(counter.add("g1", "u1", "channel-delete", 1_200, 3_000), 1);
  assert.equal(counter.add("g2", "u1", "channel-create", 1_300, 3_000), 1);
  assert.equal(counter.add("g1", "u1", "channel-create", 1_400, 3_000), 2);
  assert.equal(counter.add("g1", "u1", "channel-create", 4_401, 3_000), 1);
});

test("default responses are human judgment and bot kick only for four required detectors", () => {
  const config = createDefaultAntiNukeConfig();
  for (const detector of [
    "channel-create",
    "channel-delete",
    "member-kick",
    "member-ban",
  ] as const) {
    assert.equal(resolveDefaultResponse(detector, "human", null), "judgement");
    assert.equal(resolveDefaultResponse(detector, "bot", null), "kick");
  }
  assert.equal(resolveDefaultResponse("webhook-create", "human", null), "log");
  assert.equal(resolveDefaultResponse("webhook-create", "bot", null), "log");
  assert.equal(resolveDefaultResponse("channel-create", "unknown", null), "log");
});

test("blacklist wins over whitelist and unapproved bots follow the guild toggle", () => {
  const config = createDefaultAntiNukeConfig();
  config.whitelist["12345678901234567"] = {
    id: "12345678901234567",
    kind: "bot",
    addedBy: "owner",
    addedAt: new Date(0).toISOString(),
  };
  config.blacklist["12345678901234567"] = {
    ...config.whitelist["12345678901234567"],
    addedBy: "moderator",
  };
  assert.equal(resolveTrust(config, "12345678901234567"), "blacklisted");
  assert.equal(resolveJoinPolicy(config, "12345678901234567", true), "kick");
  assert.equal(resolveJoinPolicy(config, "22345678901234567", true), "log");
  config.unverifiedBotKick = true;
  assert.equal(resolveJoinPolicy(config, "22345678901234567", true), "kick");
  assert.equal(resolveJoinPolicy(config, "32345678901234567", false), "log");
});

test("event deduplication accepts a key once until its TTL expires", () => {
  const deduplicator = new EventDeduplicator(100);
  assert.equal(deduplicator.claim("audit:1", 1_000), true);
  assert.equal(deduplicator.claim("audit:1", 1_050), false);
  assert.equal(deduplicator.claim("audit:1", 1_101), true);
});

test("concurrent threshold responses are claimed once per executor and detector window", () => {
  const gate = new PunishmentGate();
  assert.equal(gate.claim("guild:executor:channel-delete", 1_000, 3_000), true);
  assert.equal(gate.claim("guild:executor:channel-delete", 1_000, 3_000), false);
  assert.equal(gate.claim("guild:executor:channel-create", 1_000, 3_000), true);
  assert.equal(gate.claim("other-guild:executor:channel-delete", 1_000, 3_000), true);
  assert.equal(gate.claim("guild:executor:channel-delete", 4_001, 3_000), true);
});

test("manual God's Judgment access is restricted to the actual server owner", () => {
  assert.equal(isManualJudgementOwner("owner-id", "owner-id"), true);
  assert.equal(isManualJudgementOwner("administrator-id", "owner-id"), false);
});
