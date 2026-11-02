import type { GuildMember } from "discord.js";
import { logger } from "../../lib/logger.js";
import { HeatDecayService } from "./HeatDecayService.js";
import { HeatStore, type HeatRecord } from "./HeatStore.js";
import { PunishmentExecutor } from "./PunishmentExecutor.js";
import {
  PunishmentPolicyResolver,
  type PunishmentPolicy,
} from "./PunishmentPolicyResolver.js";
import {
  HEAT_VALUES,
  SeverityPolicy,
  type HeatSeverity,
  type HeatViolationType,
} from "./SeverityPolicy.js";
import type { JudgmentExecutor } from "./PunishmentExecutor.js";

export interface HeatResult {
  record: HeatRecord;
  severity: HeatSeverity;
  punishment: PunishmentPolicy;
}

export class HeatEngine {
  private exemptionChecker: (member: GuildMember) => boolean = () => false;

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

  setExemptionChecker(checker: (member: GuildMember) => boolean): void {
    this.exemptionChecker = checker;
  }

  setJudgmentExecutor(executor: JudgmentExecutor): void {
    this.punishmentExecutor.setJudgmentExecutor(executor);
  }

  async view(guildId: string, userId: string): Promise<HeatResult> {
    const current = this.store.get(guildId, userId);
    let record = this.decay.apply(current);
    const escalationExpired =
      record.lastEscalationAt !== null &&
      Date.now() - new Date(record.lastEscalationAt).getTime() >=
        24 * 60 * 60 * 1_000;
    const warningCanBeReissued =
      record.escalationWarningIssued && record.heat < 80;

    if (escalationExpired) {
      record = {
        ...record,
        escalationCount: 0,
        escalationWarningIssued: false,
        lastEscalationAt: null,
      };
    } else if (warningCanBeReissued) {
      record = { ...record, escalationWarningIssued: false };
    }

    if (
      record.heat !== current.heat ||
      record.escalationCount !== current.escalationCount ||
      record.escalationWarningIssued !== current.escalationWarningIssued ||
      record.lastEscalationAt !== current.lastEscalationAt
    ) {
      await this.store.save(record);
    }
    return this.result(record, { punishment: "none" });
  }

  async add(
    member: GuildMember,
    amount: number,
    reason: string | null,
    applyPunishment = true,
    violationType: HeatViolationType | null = null
  ): Promise<HeatResult> {
    if (this.exemptionChecker(member)) {
      logger.info(
        `HeatEngine: skipped exempt member ${member.user.tag} (${member.id})`
      );
      return this.view(member.guild.id, member.id);
    }

    const current = await this.view(member.guild.id, member.id);
    const record = await this.store.add(
      member.guild.id,
      member.id,
      amount,
      reason,
      violationType
    );
    const punishment = this.policyResolver.resolve(
      record.heat,
      record.escalationCount,
      record.escalationWarningIssued
    );

    if (applyPunishment && punishment.punishment !== "none") {
      await this.punishmentExecutor.execute(
        member,
        punishment,
        reason ?? `Heat reached ${record.heat}.`
      );
    }

    const updatedRecord = await this.applyEscalationState(record, punishment);
    logger.info(
      `HeatEngine: added ${amount} heat to ${member.user.tag} — ` +
        `${current.record.heat} → ${updatedRecord.heat}`
    );
    return this.result(updatedRecord, punishment);
  }

  async addViolation(
    member: GuildMember,
    violationType: HeatViolationType,
    reason: string | null,
    applyPunishment = true
  ): Promise<HeatResult> {
    return this.add(
      member,
      HEAT_VALUES[violationType],
      reason,
      applyPunishment,
      violationType
    );
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

  private async applyEscalationState(
    record: HeatRecord,
    punishment: PunishmentPolicy
  ): Promise<HeatRecord> {
    if (punishment.punishment === "none") return record;

    const now = new Date().toISOString();
    const next: HeatRecord = {
      ...record,
      escalationWarningIssued:
        punishment.punishment === "warn" &&
        punishment.advancesEscalation !== true
          ? true
          : false,
      lastEscalationAt: now,
    };

    if (punishment.advancesEscalation) {
      next.escalationCount = Math.min(10, record.escalationCount + 1);
      if (punishment.resetHeatTo !== undefined) {
        next.heat = punishment.resetHeatTo;
      }
    }

    return this.store.save(next);
  }

  private result(
    record: HeatRecord,
    punishment: PunishmentPolicy = { punishment: "none" }
  ): HeatResult {
    const severity = this.severity.resolve(record.lastViolationType);
    return {
      record,
      severity,
      punishment,
    };
  }
}