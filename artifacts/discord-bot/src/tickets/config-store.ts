import { securityManager } from "../lib/registry.js";
import type { TicketConfig } from "../security/types.js";

export class TicketConfigStore {
  private readonly pendingWrites = new Map<string, Promise<TicketConfig>>();

  get(guildId: string): TicketConfig {
    return securityManager.getConfig(guildId).ticket;
  }

  async update(
    guildId: string,
    patch: Partial<TicketConfig>,
  ): Promise<TicketConfig> {
    const previous = this.pendingWrites.get(guildId) ?? Promise.resolve(this.get(guildId));
    const write = previous
      .catch(() => this.get(guildId))
      .then(async () => {
        const current = this.get(guildId);
        const next = { ...current, ...patch };
        await securityManager.updateConfig(guildId, { ticket: next });
        return this.get(guildId);
      });

    this.pendingWrites.set(guildId, write);
    try {
      return await write;
    } finally {
      if (this.pendingWrites.get(guildId) === write) {
        this.pendingWrites.delete(guildId);
      }
    }
  }

  async save(guildId: string): Promise<TicketConfig> {
    return this.update(guildId, {});
  }
}

export const ticketConfigStore = new TicketConfigStore();