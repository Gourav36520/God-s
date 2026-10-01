import { securityManager } from "../lib/registry.js";
import type { GuildSecurityConfig } from "../security/types.js";
import {
  createDefaultEmbedDefinition,
  createDefaultFlowConfig,
  createDefaultGuildConfig,
} from "./types.js";
import type {
  GreetingKind,
  SavedWelcomeGoodbyeEmbed,
  WelcomeGoodbyeEmbedDefinition,
  WelcomeGoodbyeFlowConfig,
  WelcomeGoodbyeGuildConfig,
} from "./types.js";

type GuildConfigWithWelcomeGoodbye = GuildSecurityConfig & {
  welcomeGoodbye?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeFlow(value: unknown): WelcomeGoodbyeFlowConfig {
  const source = record(value);
  const defaults = createDefaultFlowConfig();
  return {
    enabled: source.enabled === true,
    channelId: nullableString(source.channelId),
    embedId: nullableString(source.embedId),
    message: stringValue(source.message) || defaults.message,
  };
}

function normalizeEmbedDefinition(value: unknown): WelcomeGoodbyeEmbedDefinition {
  const source = record(value);
  const defaults = createDefaultEmbedDefinition();
  return {
    content: stringValue(source.content) || defaults.content,
    title: stringValue(source.title) || defaults.title,
    titleUrl: stringValue(source.titleUrl) || defaults.titleUrl,
    authorName: stringValue(source.authorName) || defaults.authorName,
    authorUrl: stringValue(source.authorUrl) || defaults.authorUrl,
    authorIconUrl: stringValue(source.authorIconUrl) || defaults.authorIconUrl,
    description: stringValue(source.description) || defaults.description,
    thumbnailUrl: stringValue(source.thumbnailUrl) || defaults.thumbnailUrl,
    imageUrl: stringValue(source.imageUrl) || defaults.imageUrl,
    footerText: stringValue(source.footerText) || defaults.footerText,
    footerIconUrl: stringValue(source.footerIconUrl) || defaults.footerIconUrl,
    footerUrl: stringValue(source.footerUrl) || defaults.footerUrl,
    color: stringValue(source.color) || defaults.color,
    timestamp: source.timestamp === true,
  };
}

function normalizeSavedEmbed(value: unknown): SavedWelcomeGoodbyeEmbed | null {
  const source = record(value);
  if (typeof source.id !== "string" || typeof source.name !== "string") {
    return null;
  }
  return {
    id: source.id,
    name: source.name,
    definition: normalizeEmbedDefinition(source.definition),
    createdAt:
      typeof source.createdAt === "string"
        ? source.createdAt
        : new Date(0).toISOString(),
  };
}

function normalizeGuildConfig(value: unknown): WelcomeGoodbyeGuildConfig {
  const source = record(value);
  return {
    welcome: normalizeFlow(source.welcome),
    goodbye: normalizeFlow(source.goodbye),
    embeds: Array.isArray(source.embeds)
      ? source.embeds
          .map(normalizeSavedEmbed)
          .filter((embed): embed is SavedWelcomeGoodbyeEmbed => embed !== null)
      : createDefaultGuildConfig().embeds,
  };
}

export class WelcomeGoodbyeStore {
  get(guildId: string): WelcomeGoodbyeGuildConfig {
    const config = securityManager.getConfig(
      guildId,
    ) as GuildConfigWithWelcomeGoodbye;
    return normalizeGuildConfig(config.welcomeGoodbye);
  }

  async updateFlow(
    guildId: string,
    kind: GreetingKind,
    patch: Partial<WelcomeGoodbyeFlowConfig>,
  ): Promise<WelcomeGoodbyeFlowConfig> {
    const current = this.get(guildId);
    const updated = { ...current[kind], ...patch };
    await this.persist(guildId, { ...current, [kind]: updated });
    return updated;
  }

  async saveEmbed(
    guildId: string,
    embed: SavedWelcomeGoodbyeEmbed,
  ): Promise<void> {
    const current = this.get(guildId);
    await this.persist(guildId, {
      ...current,
      embeds: [...current.embeds, embed],
    });
  }

  async updateEmbed(
    guildId: string,
    embed: SavedWelcomeGoodbyeEmbed,
  ): Promise<boolean> {
    const current = this.get(guildId);
    const index = current.embeds.findIndex((saved) => saved.id === embed.id);
    if (index === -1) return false;

    const embeds = [...current.embeds];
    embeds[index] = embed;
    await this.persist(guildId, { ...current, embeds });
    return true;
  }

  async deleteEmbed(
    guildId: string,
    embedId: string,
  ): Promise<SavedWelcomeGoodbyeEmbed | undefined> {
    const current = this.get(guildId);
    const index = current.embeds.findIndex((embed) => embed.id === embedId);
    if (index === -1) return undefined;

    const embeds = [...current.embeds];
    const [deleted] = embeds.splice(index, 1);
    await this.persist(guildId, { ...current, embeds });
    return deleted;
  }

  async selectEmbed(
    guildId: string,
    kind: GreetingKind,
    embedId: string,
  ): Promise<WelcomeGoodbyeFlowConfig> {
    return this.updateFlow(guildId, kind, { embedId });
  }

  findEmbed(
    guildId: string,
    embedId: string | null,
  ): SavedWelcomeGoodbyeEmbed | undefined {
    if (!embedId) return undefined;
    return this.get(guildId).embeds.find((embed) => embed.id === embedId);
  }

  private async persist(
    guildId: string,
    config: WelcomeGoodbyeGuildConfig,
  ): Promise<void> {
    // GuildConfigStore preserves unknown root properties while merging and writing
    // guild records, so this feature remains in the existing per-guild JSON config.
    const patch = { welcomeGoodbye: config } as never;
    await securityManager.updateConfig(guildId, patch);
  }
}

export const welcomeGoodbyeStore = new WelcomeGoodbyeStore();