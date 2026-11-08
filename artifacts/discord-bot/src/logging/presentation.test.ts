import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_CARD_BASE_COLOR,
  actionCardColor,
  normalizeSeverity,
  severityColor,
} from "./presentation.js";

test("severity values map to the requested action-card colors", () => {
  assert.equal(severityColor("LOW"), 0x57f287);
  assert.equal(severityColor("medium"), 0xfee75c);
  assert.equal(severityColor("High"), 0xe67e22);
  assert.equal(severityColor("critical"), 0x8b0000);
  assert.equal(actionCardColor("not-configured"), ACTION_CARD_BASE_COLOR);
  assert.equal(normalizeSeverity("none"), null);
});
