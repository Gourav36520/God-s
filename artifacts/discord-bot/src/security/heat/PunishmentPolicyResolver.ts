import type { HeatSeverity } from "./SeverityPolicy.js";

export type HeatPunishment = "none" | "warn" | "mute" | "kick";

export interface PunishmentPolicy {
  punishment: HeatPunishment;
  durationMs?: number;
}

export class PunishmentPolicyResolver {
  resolve(severity: HeatSeverity): PunishmentPolicy {
    switch (severity) {
      case "critical":
        return { punishment: "kick" };
      case "high":
        return { punishment: "mute", durationMs: 10 * 60 * 1_000 };
      case "medium":
        return { punishment: "warn" };
      case "low":
      case "none":
        return { punishment: "none" };
    }
  }
}