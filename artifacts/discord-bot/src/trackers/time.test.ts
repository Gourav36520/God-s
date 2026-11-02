import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addIntervalByKolkataDay, kolkataDateKey } from "./time.js";

describe("Kolkata tracker dates", () => {
  it("uses Asia/Kolkata when identifying the current day", () => {
    assert.equal(kolkataDateKey(Date.parse("2026-10-10T18:29:59.000Z")), "2026-10-10");
    assert.equal(kolkataDateKey(Date.parse("2026-10-10T18:30:00.000Z")), "2026-10-11");
  });

  it("splits voice time at local midnight without losing milliseconds", () => {
    const totals: Record<string, number> = {};
    addIntervalByKolkataDay(
      Date.parse("2026-10-10T18:29:30.000Z"),
      Date.parse("2026-10-10T18:30:30.000Z"),
      (dateKey, durationMs) => {
        totals[dateKey] = (totals[dateKey] ?? 0) + durationMs;
      },
    );

    assert.deepEqual(totals, {
      "2026-10-10": 30_000,
      "2026-10-11": 30_000,
    });
  });
});
