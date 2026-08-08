import type { GuildMember } from "discord.js";
import type { PunishmentPolicy } from "./PunishmentPolicyResolver.js";

export class PunishmentExecutor {
  async execute(
    member: GuildMember,
    policy: PunishmentPolicy,
    reason: string
  ): Promise<void> {
    switch (policy.punishment) {
      case "none":
        return;
      case "warn":
        await member.send(`⚠️ **Heat warning** in **${member.guild.name}**: ${reason}`).catch(() => null);
        return;
      case "mute":
        await member.timeout(policy.durationMs ?? 10 * 60 * 1_000, reason);
        return;
      case "kick":
        await member.kick(reason);
        return;
    }
  }
}