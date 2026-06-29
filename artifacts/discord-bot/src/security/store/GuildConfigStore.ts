import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { GuildSecurityConfig } from "../types.js";
import { buildDefaultConfig } from "../defaults.js";
import { logger } from "../../lib/logger.js";

const DATA_DIR = join(process.cwd(), "data");
const CONFIG_FILE = join(DATA_DIR, "guild-configs.json");

type ConfigMap = Record<string, GuildSecurityConfig>;

function mergeWithDefaults(
  stored: GuildSecurityConfig,
  defaults: GuildSecurityConfig
): GuildSecurityConfig {
  const VALID_SPAM_ACTIONS = ["warn", "timeout", "judgment"] as const;

  return {
    ...defaults,
    ...stored,
    antiSpam: {
      ...defaults.antiSpam,
      ...stored.antiSpam,
      action: VALID_SPAM_ACTIONS.includes(stored.antiSpam?.action as never)
        ? stored.antiSpam.action
        : defaults.antiSpam.action,
      bypassRoles: stored.antiSpam?.bypassRoles ?? [],
      bypassUsers: stored.antiSpam?.bypassUsers ?? [],
    },
    antiLink: { ...defaults.antiLink, ...stored.antiLink },
    antiInvite: { ...defaults.antiInvite, ...stored.antiInvite },
    antiRaid: { ...defaults.antiRaid, ...stored.antiRaid },
    godsJudgment: { ...defaults.godsJudgment, ...stored.godsJudgment },
    logging: {
      ...defaults.logging,
      ...stored.logging,
      categories: {
        ...defaults.logging.categories,
        ...(stored.logging?.categories ?? {}),
      },
    },
  };
}

export class GuildConfigStore {
  private cache: Map<string, GuildSecurityConfig> = new Map();
  private ready = false;

  async init(): Promise<void> {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }

    if (!existsSync(CONFIG_FILE)) {
      await this.flush({});
      logger.info("GuildConfigStore: created new config file");
    } else {
      const raw = await readFile(CONFIG_FILE, "utf-8");
      const data: ConfigMap = JSON.parse(raw);
      for (const [guildId, stored] of Object.entries(data)) {
        const merged = mergeWithDefaults(stored, buildDefaultConfig(guildId));
        this.cache.set(guildId, merged);
      }
      logger.info(`GuildConfigStore: loaded ${this.cache.size} guild config(s)`);
    }

    this.ready = true;
  }

  get(guildId: string): GuildSecurityConfig {
    this.assertReady();
    if (!this.cache.has(guildId)) {
      const defaults = buildDefaultConfig(guildId);
      this.cache.set(guildId, defaults);
    }
    return this.cache.get(guildId)!;
  }

  async set(config: GuildSecurityConfig): Promise<void> {
    this.assertReady();
    config.updatedAt = new Date().toISOString();
    this.cache.set(config.guildId, config);
    await this.persist();
  }

  async update(
    guildId: string,
    patch: Partial<Omit<GuildSecurityConfig, "guildId" | "updatedAt">>
  ): Promise<GuildSecurityConfig> {
    this.assertReady();
    const current = this.get(guildId);
    const updated: GuildSecurityConfig = {
      ...current,
      ...patch,
      guildId,
      updatedAt: new Date().toISOString(),
    };
    this.cache.set(guildId, updated);
    await this.persist();
    return updated;
  }

  async delete(guildId: string): Promise<void> {
    this.assertReady();
    this.cache.delete(guildId);
    await this.persist();
  }

  has(guildId: string): boolean {
    this.assertReady();
    return this.cache.has(guildId);
  }

  all(): GuildSecurityConfig[] {
    this.assertReady();
    return [...this.cache.values()];
  }

  private async persist(): Promise<void> {
    const data: ConfigMap = {};
    for (const [guildId, config] of this.cache) {
      data[guildId] = config;
    }
    await this.flush(data);
  }

  private async flush(data: ConfigMap): Promise<void> {
    await writeFile(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("GuildConfigStore has not been initialized. Call init() first.");
    }
  }
}
