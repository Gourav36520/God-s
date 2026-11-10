import assert from "node:assert/strict";
import test from "node:test";
import {
  createModerationCardSvg,
  renderModerationCard,
} from "./moderationCard.js";

const severityPreviews = [
  { severity: "low", color: "#57f287" },
  { severity: "medium", color: "#fee75c" },
  { severity: "high", color: "#e67e22" },
  { severity: "critical", color: "#8b0000" },
] as const;

function previewOptions(severity: string) {
  return {
    action: "Member Banned",
    targetName: "Nova",
    targetUsername: "@nova",
    targetId: "482901736154209281",
    moderatorName: "Kai",
    moderatorUsername: "@kai",
    moderatorId: "928374650192837465",
    severity,
    reason: "Repeated phishing-link spam",
    details: [
      { label: "Additional information", value: "Example moderation detail" },
    ],
    timestamp: new Date("2026-11-10T04:12:00.000Z"),
    caseId: 1048,
  };
}

test("severity previews use the configured colors without changing card layout", () => {
  const normalizedPreviews = severityPreviews.map(({ severity, color }) => {
    const svg = createModerationCardSvg(previewOptions(severity));
    assert.ok(svg.includes(`stroke="${color}"`));
    assert.ok(svg.includes(`fill="${color}"`));
    assert.ok(svg.includes(severity.toUpperCase()));
    assert.ok(svg.includes("Nova"));
    assert.ok(svg.includes("482901736154209281"));
    assert.ok(svg.includes("Repeated phishing-link spam"));
    return svg
      .replaceAll(color, "<severity-color>")
      .replaceAll("#ffffff", "<severity-text-color>")
      .replaceAll("#171922", "<severity-text-color>")
      .replace(severity.toUpperCase(), "<severity-label>");
  });

  assert.ok(normalizedPreviews.every((svg) => svg === normalizedPreviews[0]));
});

test("missing moderation data falls back safely and escapes user text", () => {
  const svg = createModerationCardSvg({
    action: "Timeout",
    targetName: "",
    targetUsername: "",
    targetId: "Unknown",
    moderatorName: "",
    moderatorUsername: "",
    moderatorId: "Unavailable",
    reason: "<script>alert(1)</script>",
  });

  assert.ok(svg.includes("Unknown user"));
  assert.ok(svg.includes("Username unavailable"));
  assert.ok(svg.includes("Moderator unavailable"));
  assert.ok(svg.includes("UNRATED"));
  assert.ok(svg.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!svg.includes("<script>"));
});

test("each severity card renders to a PNG", async () => {
  for (const { severity } of severityPreviews) {
    const png = await renderModerationCard(previewOptions(severity));
    assert.deepEqual(
      png.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  }
});
