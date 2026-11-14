import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEVEL_CLASSES,
  calculateLevelProgress,
  formatCompactXp,
  xpToReachLevel,
} from "./progression.js";

describe("level progression", () => {
  it("keeps the configured class names in order", () => {
    assert.deepEqual(LEVEL_CLASSES, [
      "Poor Class",
      "Middle Poor",
      "High Poor",
      "Low Middle Class",
      "Middle Class",
      "High Middle Class",
      "Rich Class",
      "Middle Rich",
      "High Rich",
      "Millionaire",
      "Centimillionaire",
      "Billionaire",
      "Multimillionaire",
      "Trillionaire",
      "Infinity",
    ]);
  });

  it("advances levels from cumulative XP thresholds", () => {
    assert.equal(xpToReachLevel(1n), 0n);
    assert.equal(xpToReachLevel(2n), 100n);
    assert.equal(xpToReachLevel(3n), 300n);
    assert.equal(calculateLevelProgress(99n).className, "Poor Class");
    assert.equal(calculateLevelProgress(100n).className, "Middle Poor");
    assert.equal(calculateLevelProgress(100n).xpIntoLevel, 0n);
  });

  it("keeps increasing levels and XP progress within Infinity", () => {
    const infinityStart = calculateLevelProgress(xpToReachLevel(15n));
    const laterInfinity = calculateLevelProgress(xpToReachLevel(18n) + 55n);

    assert.equal(infinityStart.className, "Infinity");
    assert.equal(infinityStart.nextClassName, null);
    assert.equal(laterInfinity.className, "Infinity");
    assert.equal(laterInfinity.level, 18);
    assert.equal(laterInfinity.nextClassName, null);
    assert.equal(laterInfinity.xpIntoLevel, 55n);
    assert.equal(laterInfinity.xpRequiredForNextLevel, 1_800n);
  });

  it("formats compact XP for recent and lifetime card totals", () => {
    assert.equal(formatCompactXp(20_800n), "20.8K");
    assert.equal(formatCompactXp(8_400n), "8.4K");
    assert.equal(formatCompactXp(800n), "800");
  });
});
