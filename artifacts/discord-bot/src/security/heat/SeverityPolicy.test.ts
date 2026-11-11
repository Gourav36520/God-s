import assert from "node:assert/strict";
import test from "node:test";
import {
  HEAT_VALUES,
  SEVERITY_POLICY,
  SeverityPolicy,
} from "./SeverityPolicy.js";
import type {
  CriticalEventType,
  HeatSeverity,
  SeverityEventType,
} from "./SeverityPolicy.js";

const eventCases: Array<[SeverityEventType, number, HeatSeverity]> = [
  ["spam", 5, "low"],
  ["caps", 5, "low"],
  ["emoji", 5, "low"],
  ["sticker", 5, "low"],
  ["attachment", 15, "medium"],
  ["mentionSpam", 15, "medium"],
  ["inviteLink", 30, "high"],
  ["botSpam", 30, "high"],
  ["raid", 30, "high"],
  ["webhookRaid", 50, "critical"],
  ["massBan", 50, "critical"],
  ["massKick", 50, "critical"],
  ["massChannelDelete", 50, "critical"],
];

test("severity policy uses the configured points and levels", () => {
  const policy = new SeverityPolicy();

  for (const [eventType, points, severity] of eventCases) {
    assert.equal(SEVERITY_POLICY[eventType].points, points, eventType);
    assert.equal(policy.resolve(eventType), severity, eventType);
  }
});

test("critical events stay outside normal HeatEngine escalation inputs", () => {
  const criticalEvents: CriticalEventType[] = [
    "webhookRaid",
    "massBan",
    "massKick",
    "massChannelDelete",
  ];

  for (const eventType of criticalEvents) {
    assert.equal(SEVERITY_POLICY[eventType].escalation, "separate", eventType);
    assert.equal(Object.hasOwn(HEAT_VALUES, eventType), false, eventType);
  }
});

test("normal HeatEngine inputs use the exact non-critical point values", () => {
  assert.deepEqual(HEAT_VALUES, {
    spam: 5,
    caps: 5,
    emoji: 5,
    sticker: 5,
    attachment: 15,
    mentionSpam: 15,
    inviteLink: 30,
    botSpam: 30,
    raid: 30,
  });
});
