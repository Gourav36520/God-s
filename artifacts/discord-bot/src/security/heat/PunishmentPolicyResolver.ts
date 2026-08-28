export type HeatPunishment = "none" | "warn" | "mute" | "judgment";

export interface PunishmentPolicy {
  punishment: HeatPunishment;
  durationMs?: number;
  resetHeatTo?: number;
  advancesEscalation?: boolean;
}

export class PunishmentPolicyResolver {
  resolve(
    heat: number,
    escalationCount: number,
    escalationWarningIssued: boolean
  ): PunishmentPolicy {
    const escalation = Math.min(10, Math.max(1, escalationCount + 1));

    if (escalation <= 2) {
      return heat >= 100
        ? { punishment: "warn", resetHeatTo: 50, advancesEscalation: true }
        : { punishment: "none" };
    }

    if (heat >= 100) {
      if (escalation === 10) {
        return { punishment: "judgment", advancesEscalation: true };
      }
      return {
        punishment: "mute",
        durationMs: escalation >= 7 ? 60 * 60 * 1_000 : escalation >= 5 ? 30 * 60 * 1_000 : 10 * 60 * 1_000,
        advancesEscalation: true,
      };
    }

    if (heat >= 80 && !escalationWarningIssued) {
      return { punishment: "warn" };
    }

    return { punishment: "none" };
  }
}