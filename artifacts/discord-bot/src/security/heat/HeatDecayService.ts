import type { HeatRecord } from "./HeatStore.js";

const DECAY_INTERVAL_MS = 60 * 1_000;
const DECAY_AMOUNT = 1;

export class HeatDecayService {
  apply(record: HeatRecord, now = Date.now()): HeatRecord {
    if (record.heat <= 0 || record.updatedAt === new Date(0).toISOString()) {
      return record;
    }

    const elapsedIntervals = Math.floor(
      (now - new Date(record.updatedAt).getTime()) / DECAY_INTERVAL_MS
    );
    if (elapsedIntervals <= 0) return record;

    return {
      ...record,
      heat: Math.max(0, record.heat - elapsedIntervals * DECAY_AMOUNT),
    };
  }
}