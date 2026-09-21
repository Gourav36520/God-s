import type { Client, GuildMember, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { GuildConfigStore } from "./store/GuildConfigStore.js";
import type {
  GuildSecurityConfig,
  JudgmentResult,
  ModuleKey,
  SecurityAction,
  SecurityActionResult,
} from "./types.js";
import { logger } from "../lib/logger.js";
import type { BaseSecurityModule } from "./BaseSecurityModule.js";
import { HeatEngine } from "./heat/HeatEngine.js";

export class SecurityManager {
  private readonly store: GuildConfigStore;
  private client: Client | null = null;
  private readonly modules = new Map<ModuleKey, BaseSecurityModule>();
  private readonly heatEngine: HeatEngine;

  constructor() {
    this.store = new GuildConfigStore();
    this.heatEngine = new HeatEngine();
    this.heatEngine.setExemptionChecker((member) => this.isExempt(member));
    this.heatEngine.setJudgmentExecutor(async (member, reason) => {
      const judgedBy = this.client?.user?.id ?? "heat-engine";
      const result = await this.placeInJudgment(member, reason, judgedBy);
      if (!result.success) {
        throw new Error(result.reason);
      }
    });
  }

  async init(client: Client): Promise<void> {
    this.client = client;
    await this.store.init();
    await this.heatEngine.init();
    logger.info("SecurityManager: initialized");
  }

  getHeatEngine(): HeatEngine {
    return this.heatEngine;
  }

  registerModule(module: BaseSecurityModule): void {
    this.modules.set(module.moduleKey, module);
    logger.info(`SecurityManager: registered module "${module.name}"`);
  }

  getModule<T extends BaseSecurityModule>(key: ModuleKey): T | undefined {
    return this.modules.get(key) as T | undefined;
  }

  getConfig(guildId: string): GuildSecurityConfig {
    return this.store.get(guildId);
  }

  async updateConfig(
    guildId: string,
    patch: Partial<Omit<GuildSecurityConfig, "guildId" | "updatedAt">>
  ): Promise<GuildSecurityConfig> {
    return this.store.update(guildId, patch);
  }

  async updateModuleConfig<K extends ModuleKey>(
    guildId: string,
    module: K,
    patch: Partial<GuildSecurityConfig[K]>
  ): Promise<GuildSecurityConfig> {
    const current = this.store.get(guildId);
    const updatedModule = { ...current[module], ...patch };
    return this.store.update(guildId, { [module]: updatedModule });
  }

  async setModuleEnabled(
    guildId: string,
    module: ModuleKey,
    enabled: boolean
  ): Promise<void> {
    await this.updateModuleConfig(guildId, module, { enabled } as never);
    logger.info(
      `SecurityManager: ${module} ${enabled ? "enabled" : "disabled"} in guild ${guildId}`
    );
  }

  isExempt(member: GuildMember): boolean {
    const config = this.store.get(member.guild.id);
    if (member.permissions.has("Administrator")) return true;
    return member.roles.cache.some((r) => config.exemptRoles.includes(r.id));
  }

  isAntiSpamExempt(member: GuildMember): boolean {
    const config = this.store.get(member.guild.id);
    return (
      config.antiSpam.bypassUsers.includes(member.id) ||
      member.roles.cache.some((role) =>
        config.antiSpam.bypassRoles.includes(role.id)
      )
    );
  }

  isAntiLinkExempt(member: GuildMember): boolean {
    const config = this.store.get(member.guild.id);
    return member.roles.cache.some((role) =>
      config.antiLink.bypassRoles.includes(role.id)
    );
  }

  isExemptChannel(channelId: string, guildId: string): boolean {
    const config = this.store.get(guildId);
    return config.exemptChannels.includes(channelId);
  }

  async applyAction(
    member: GuildMember,
    action: SecurityAction,
    reason: string,
    muteDurationMs?: number
  ): Promise<SecurityActionResult> {
    const base = { action, reason, targetId: member.id, guildId: member.guild.id };

    try {
      switch (action) {
        case "warn": {
          await member
            .send(`⚠️ **Warning** in **${member.guild.name}**: ${reason}`)
            .catch(() => null);
          return { success: true, ...base };
        }
        case "delete": {
          return { success: true, ...base };
        }
        case "mute": {
          const durationMs = muteDurationMs ?? 10 * 60 * 1000;
          await member.timeout(durationMs, reason);
          return { success: true, ...base };
        }
        case "kick": {
          await member.kick(reason);
          return { success: true, ...base };
        }
        case "ban": {
          await member.ban({ reason });
          return { success: true, ...base };
        }
        default: {
          return {
            success: false,
            action: null,
            reason: `Unknown action: ${action}`,
          };
        }
      }
    } catch (err) {
      logger.error(
        `SecurityManager: failed to apply action ${action} on ${member.id}:`,
        err
      );
      return {
        success: false,
        action,
        reason: `Failed to apply action: ${String(err)}`,
      };
    }
  }

  async placeInJudgment(
    member: GuildMember,
    reason: string,
    judgedBy: string
  ): Promise<JudgmentResult> {
    const { GodsJudgment } = await import("./modules/GodsJudgment.js");
    const module =
      this.getModule<InstanceType<typeof GodsJudgment>>("godsJudgment");
    if (!module) {
      return {
        success: false,
        reason: "God's Judgment module is not registered.",
      };
    }
    return module.placeInJudgment(member, reason, judgedBy);
  }

  async releaseFromJudgment(
    member: GuildMember,
    reason: string,
    releasedBy: string
  ): Promise<JudgmentResult> {
    const { GodsJudgment } = await import("./modules/GodsJudgment.js");
    const module =
      this.getModule<InstanceType<typeof GodsJudgment>>("godsJudgment");
    if (!module) {
      return {
        success: false,
        reason: "God's Judgment module is not registered.",
      };
    }
    return module.release(member, reason, releasedBy);
  }

  async sendLog(guildId: string, content: string): Promise<void> {
    if (!this.client) return;
    const config = this.store.get(guildId);
    const channelId = config.logChannelId;
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send(content);
      }
    } catch (err) {
      logger.warn(
        `SecurityManager: could not send log to channel ${channelId}:`,
        err
      );
    }
  }

  async sendLogEmbed(guildId: string, embed: EmbedBuilder): Promise<void> {
    if (!this.client) return;
    const config = this.store.get(guildId);
    const channelId = config.logChannelId;
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send({ embeds: [embed] });
      }
    } catch (err) {
      logger.warn(
        `SecurityManager: could not send log embed to channel ${channelId}:`,
        err
      );
    }
  }

  buildLogEmbed(options: {
    title: string;
    description: string;
    color?: number;
    fields?: { name: string; value: string; inline?: boolean }[];
  }): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle(options.title)
      .setDescription(options.description)
      .setColor(options.color ?? 0xed4245)
      .setTimestamp();
    if (options.fields) embed.addFields(options.fields);
    return embed;
  }

  getModuleStatus(guildId: string): Record<ModuleKey, boolean> {
    const config = this.store.get(guildId);
    return {
      antiSpam: config.antiSpam.enabled,
      antiMention: config.antiMention.enabled,
      antiLink: config.antiLink.enabled,
      antiInvite: config.antiInvite.enabled,
      antiRaid: config.antiRaid.enabled,
      godsJudgment: config.godsJudgment.enabled,
    };
  }

  get configStore(): GuildConfigStore {
    return this.store;
  }
}
