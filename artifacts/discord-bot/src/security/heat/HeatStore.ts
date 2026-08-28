import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { logger } from "../../lib/logger.js";
import type { HeatViolationType } from "./SeverityPolicy.js";

export interface HeatRecord {
  guildId: string;
  userId: string;
  heat: number;
  events: number;
  lastReason: string | null;
  lastViolationType: HeatViolationType | null;
  escalationCount: number;
  escalationWarningIssued: boolean;
  lastEscalationAt: string | null;
  updatedAt: string;
}

type HeatData = Record<string, HeatRecord>;

const DATA_DIR = join(process.cwd(), "data");
const HEAT_FILE = join(DATA_DIR, "heat.json");
const INITIAL_TIMESTAMP = new Date(0).toISOString();

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

export class HeatStore {
  private readonly records = new Map<string, HeatRecord>();
  private ready = false;

  async init(): Promise<void> {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }

    if (!existsSync(HEAT_FILE)) {
      await this.flush();
      logger.info("HeatStore: created heat data file");
    } else {
      const raw = await readFile(HEAT_FILE, "utf-8");
      const data = JSON.parse(raw) as HeatData;
      for (const [recordKey, record] of Object.entries(data)) {
        this.records.set(recordKey, this.normalize(record));
      }
      logger.info(`HeatStore: loaded ${this.records.size} heat record(s)`);
    }

    this.ready = true;
  }

  get(guildId: string, userId: string): HeatRecord {
    this.assertReady();
    return (
      this.records.get(key(guildId, userId)) ?? {
        guildId,
        userId,
        heat: 0,
        events: 0,
        lastReason: null,
        lastViolationType: null,
        escalationCount: 0,
        escalationWarningIssued: false,
        lastEscalationAt: null,
        updatedAt: INITIAL_TIMESTAMP,
      }
    );
  }

  async save(record: HeatRecord): Promise<HeatRecord> {
    this.assertReady();
    const normalized: HeatRecord = {
      ...record,
      heat: Math.max(0, Math.round(record.heat)),
      events: Math.max(0, Math.round(record.events)),
      escalationCount: Math.max(0, Math.round(record.escalationCount)),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key(record.guildId, record.userId), normalized);
    await this.flush();
    return normalized;
  }

  async add(
    guildId: string,
    userId: string,
    amount: number,
    reason: string | null,
    violationType: HeatViolationType | null = null
  ): Promise<HeatRecord> {
    const current = this.get(guildId, userId);
    return this.save({
      ...current,
      heat: current.heat + amount,
      events: current.events + 1,
      lastReason: reason,
      lastViolationType: violationType ?? current.lastViolationType,
    });
  }

  async remove(
    guildId: string,
    userId: string,
    amount: number,
    reason: string | null
  ): Promise<HeatRecord> {
    const current = this.get(guildId, userId);
    return this.save({
      ...current,
      heat: current.heat - amount,
      lastReason: reason,
    });
  }

  async reset(guildId: string, userId: string): Promise<HeatRecord> {
    return this.save({
      ...this.get(guildId, userId),
      heat: 0,
      events: 0,
      lastReason: null,
    });
  }

  private async flush(): Promise<void> {
    const data: HeatData = {};
    for (const [recordKey, record] of this.records) {
      data[recordKey] = record;
    }
    await writeFile(HEAT_FILE, JSON.stringify(data, null, 2), "utf-8");
  }

  private normalize(record: HeatRecord): HeatRecord {
    return {
      ...record,
      heat: Math.max(0, Math.round(record.heat ?? 0)),
      events: Math.max(0, Math.round(record.events ?? 0)),
      lastViolationType: record.lastViolationType ?? null,
      escalationCount: Math.max(0, Math.round(record.escalationCount ?? 0)),
      escalationWarningIssued: record.escalationWarningIssued ?? false,
      lastEscalationAt: record.lastEscalationAt ?? null,
      updatedAt: record.updatedAt ?? INITIAL_TIMESTAMP,
    };
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("HeatStore has not been initialized. Call init() first.");
    }
  }
}