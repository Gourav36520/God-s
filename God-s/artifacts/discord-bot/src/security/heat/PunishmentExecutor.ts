import type { GuildMember } from "discord.js";
import type { PunishmentPolicy } from "./PunishmentPolicyResolver.js";

export type JudgmentExecutor = (
  member: GuildMember,
  reason: string
) => Promise<void>;

export class PunishmentExecutor {
  private judgmentExecutor: JudgmentExecutor | null = null;

  setJudgmentExecutor(executor: JudgmentExecutor): void {
    this.judgmentExecutor = executor;
  }

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
      case "judgment":
        if (!this.judgmentExecutor) {
          throw new Error("God's Judgment executor is not configured.");
        }
        await this.judgmentExecutor(member, reason);
        return;
    }
  }
}