import type { GuildMember } from "discord.js";
import { logger } from "../../lib/logger.js";
import { HeatDecayService } from "./HeatDecayService.js";
import { HeatStore, type HeatRecord } from "./HeatStore.js";
import { PunishmentExecutor } from "./PunishmentExecutor.js";
import {
  PunishmentPolicyResolver,
  type PunishmentPolicy,
} from "./PunishmentPolicyResolver.js";
import { SeverityPolicy, type HeatSeverity } from "./SeverityPolicy.js";

export interface HeatResult {
  record: HeatRecord;
  severity: HeatSeverity;
  punishment: PunishmentPolicy;
}

export class HeatEngine {
  constructor(
    private readonly store = new HeatStore(),
    private readonly decay = new HeatDecayService(),
    private readonly severity = new SeverityPolicy(),
    private readonly policyResolver = new PunishmentPolicyResolver(),
    private readonly punishmentExecutor = new PunishmentExecutor()
  ) {}

  async init(): Promise<void> {
    await this.store.init();
    logger.info("HeatEngine: initialized");
  }

  async view(guildId: string, userId: string): Promise<HeatResult> {
    const current = this.store.get(guildId, userId);
    const record = this.decay.apply(current);
    if (record.heat !== current.heat) {
      await this.store.save(record);
    }
    return this.result(record);
  }

  async add(
    member: GuildMember,
    amount: number,
    reason: string | null,
    applyPunishment = true
  ): Promise<HeatResult> {
    const current = await this.view(member.guild.id, member.id);
    const record = await this.store.add(
      member.guild.id,
      member.id,
      amount,
      reason
    );
    const result = this.result(record);
    if (applyPunishment && result.punishment.punishment !== "none") {
      await this.punishmentExecutor.execute(
        member,
        result.punishment,
        reason ?? `Heat reached ${record.heat}.`
      );
    }
    logger.info(
      `HeatEngine: added ${amount} heat to ${member.user.tag} — ` +
        `${current.record.heat} → ${record.heat}`
    );
    return result;
  }

  async remove(
    guildId: string,
    userId: string,
    amount: number,
    reason: string | null
  ): Promise<HeatResult> {
    return this.result(await this.store.remove(guildId, userId, amount, reason));
  }

  async reset(guildId: string, userId: string): Promise<HeatResult> {
    return this.result(await this.store.reset(guildId, userId));
  }

  private result(record: HeatRecord): HeatResult {
    const severity = this.severity.resolve(record.heat);
    return {
      record,
      severity,
      punishment: this.policyResolver.resolve(severity),
    };
  }
}