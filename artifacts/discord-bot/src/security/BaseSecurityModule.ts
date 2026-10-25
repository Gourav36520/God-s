import type { GuildMember, Message, TextChannel } from "discord.js";
import type { SecurityManager } from "./SecurityManager.js";
import type { ModuleKey, SecurityAction, SecurityActionResult } from "./types.js";

export abstract class BaseSecurityModule {
  readonly moduleKey: ModuleKey;
  protected readonly manager: SecurityManager;

  constructor(key: ModuleKey, manager: SecurityManager) {
    this.moduleKey = key;
    this.manager = manager;
  }

  isEnabled(guildId: string): boolean {
    const config = this.manager.getConfig(guildId);
    return (config[this.moduleKey] as { enabled: boolean }).enabled;
  }

  isExempt(member: GuildMember): boolean {
    return this.manager.isExempt(member);
  }

  isExemptChannel(channelId: string, guildId: string): boolean {
    return this.manager.isExemptChannel(channelId, guildId);
  }

  protected async applyAction(
    member: GuildMember,
    action: SecurityAction,
    reason: string,
    muteDurationMs?: number
  ): Promise<SecurityActionResult> {
    return this.manager.applyAction(member, action, reason, muteDurationMs);
  }

  protected async deleteMessage(message: Message): Promise<void> {
    if (message.deletable) {
      await message.delete().catch(() => null);
    }
  }

  protected async sendLog(guildId: string, content: string): Promise<void> {
    return this.manager.sendLog(guildId, content);
  }

  protected async sendModuleLog(
    channel: TextChannel,
    content: string
  ): Promise<void> {
    await channel.send(content).catch(() => null);
  }

  abstract get name(): string;
  abstract get description(): string;
}
