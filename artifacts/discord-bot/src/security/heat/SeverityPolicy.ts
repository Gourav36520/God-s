export type HeatSeverity = "none" | "low" | "medium" | "high" | "critical";

export class SeverityPolicy {
  resolve(heat: number): HeatSeverity {
    if (heat >= 20) return "critical";
    if (heat >= 10) return "high";
    if (heat >= 5) return "medium";
    if (heat > 0) return "low";
    return "none";
  }
}