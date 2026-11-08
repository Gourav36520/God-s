export type LogSeverity = "low" | "medium" | "high" | "critical";

export const ACTION_CARD_BASE_COLOR = 0xfee75c;

const SEVERITY_COLORS: Record<LogSeverity, number> = {
  low: 0x57f287,
  medium: 0xfee75c,
  high: 0xe67e22,
  critical: 0x8b0000,
};

export function normalizeSeverity(value: unknown): LogSeverity | null {
  if (typeof value !== "string") return null;
  const severity = value.trim().toLowerCase();

  return severity === "low" ||
    severity === "medium" ||
    severity === "high" ||
    severity === "critical"
    ? severity
    : null;
}

export function severityColor(value: unknown): number | null {
  const severity = normalizeSeverity(value);
  return severity ? SEVERITY_COLORS[severity] : null;
}

export function actionCardColor(value: unknown): number {
  return severityColor(value) ?? ACTION_CARD_BASE_COLOR;
}

export function moderationActionKeys(action: string): string[] {
  switch (action.trim().toLowerCase().replace(/\s+/g, "-")) {
    case "ban":
    case "softban":
    case "softban-partial":
      return ["ban", "unban"];
    case "unban":
      return ["unban"];
    case "kick":
      return ["kick"];
    case "timeout":
    case "mute":
      return ["timeout"];
    case "untimeout":
      return ["untimeout"];
    case "server-mute":
    case "server-unmute":
    case "server-deafen":
    case "server-undeafen":
      return [action.trim().toLowerCase().replace(/\s+/g, "-")];
    default:
      return [];
  }
}
