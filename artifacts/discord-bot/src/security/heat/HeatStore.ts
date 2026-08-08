import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { logger } from "../../lib/logger.js";

export interface HeatRecord {
  guildId: string;
  userId: string;
  heat: number;
  events: number;
  lastReason: string | null;
  updatedAt: string;
}

type HeatData = Record<string, HeatRecord>;

const DATA_DIR = join(process.cwd(), "data");
const HEAT_FILE = join(DATA_DIR, "heat.json");

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
        this.records.set(recordKey, record);
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
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  async save(record: HeatRecord): Promise<HeatRecord> {
    this.assertReady();
    const normalized: HeatRecord = {
      ...record,
      heat: Math.max(0, Math.round(record.heat)),
      events: Math.max(0, Math.round(record.events)),
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
    reason: string | null
  ): Promise<HeatRecord> {
    const current = this.get(guildId, userId);
    return this.save({
      ...current,
      heat: current.heat + amount,
      events: current.events + 1,
      lastReason: reason,
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

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("HeatStore has not been initialized. Call init() first.");
    }
  }
}