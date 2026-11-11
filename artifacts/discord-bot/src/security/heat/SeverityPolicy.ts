export type HeatSeverity =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "critical";

export type HeatViolationType =
  | "spam"
  | "caps"
  | "emoji"
  | "sticker"
  | "attachment"
  | "mentionSpam"
  | "inviteLink"
  | "botSpam"
  | "raid";

export type CriticalEventType =
  | "webhookRaid"
  | "massBan"
  | "massKick"
  | "massChannelDelete";

export type SeverityEventType = HeatViolationType | CriticalEventType;

export const SEVERITY_POLICY = {
  spam: { points: 5, severity: "low", escalation: "heat" },
  caps: { points: 5, severity: "low", escalation: "heat" },
  emoji: { points: 5, severity: "low", escalation: "heat" },
  sticker: { points: 5, severity: "low", escalation: "heat" },
  attachment: { points: 15, severity: "medium", escalation: "heat" },
  mentionSpam: { points: 15, severity: "medium", escalation: "heat" },
  inviteLink: { points: 30, severity: "high", escalation: "heat" },
  botSpam: { points: 30, severity: "high", escalation: "heat" },
  raid: { points: 30, severity: "high", escalation: "heat" },
  webhookRaid: { points: 50, severity: "critical", escalation: "separate" },
  massBan: { points: 50, severity: "critical", escalation: "separate" },
  massKick: { points: 50, severity: "critical", escalation: "separate" },
  massChannelDelete: {
    points: 50,
    severity: "critical",
    escalation: "separate",
  },
} as const satisfies Record<
  SeverityEventType,
  {
    points: number;
    severity: Exclude<HeatSeverity, "none">;
    escalation: "heat" | "separate";
  }
>;

export const HEAT_VALUES = {
  spam: SEVERITY_POLICY.spam.points,
  caps: SEVERITY_POLICY.caps.points,
  emoji: SEVERITY_POLICY.emoji.points,
  sticker: SEVERITY_POLICY.sticker.points,
  attachment: SEVERITY_POLICY.attachment.points,
  mentionSpam: SEVERITY_POLICY.mentionSpam.points,
  inviteLink: SEVERITY_POLICY.inviteLink.points,
  botSpam: SEVERITY_POLICY.botSpam.points,
  raid: SEVERITY_POLICY.raid.points,
} as const satisfies Record<HeatViolationType, number>;

export class SeverityPolicy {
  resolve(eventType: SeverityEventType | null): HeatSeverity {
    if (eventType === null) return "none";
    return SEVERITY_POLICY[eventType].severity;
  }
}