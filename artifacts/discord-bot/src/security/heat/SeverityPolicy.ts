export const HEAT_VALUES = {
  caps: 5,
  emoji: 8,
  sticker: 8,
  attachment: 12,
  mentionSpam: 15,
} as const;

export type HeatViolationType = keyof typeof HEAT_VALUES;
export type HeatSeverity = "none" | "low" | "medium";

export class SeverityPolicy {
  resolve(violationType: HeatViolationType | null): HeatSeverity {
    if (violationType === null) return "none";
    if (
      violationType === "caps" ||
      violationType === "emoji" ||
      violationType === "sticker"
    ) {
      return "low";
    }
    return "medium";
  }
}