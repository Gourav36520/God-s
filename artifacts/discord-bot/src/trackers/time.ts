export type LeaderboardPeriod = "all-time" | "today" | "yesterday";

const DAY_MS = 24 * 60 * 60 * 1_000;
const KOLKATA_OFFSET_MS = (5 * 60 + 30) * 60 * 1_000;

const kolkataDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function kolkataDateKey(timestamp: number): string {
  const parts = Object.fromEntries(
    kolkataDateFormatter
      .formatToParts(new Date(timestamp))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dateKeyForPeriod(
  period: Exclude<LeaderboardPeriod, "all-time">,
  now = Date.now(),
): string {
  return kolkataDateKey(period === "today" ? now : now - DAY_MS);
}

export function periodLabel(period: LeaderboardPeriod): string {
  if (period === "all-time") return "All-time";
  return period === "today" ? "Today" : "Yesterday";
}

export function addIntervalByKolkataDay(
  startMs: number,
  endMs: number,
  add: (dateKey: string, durationMs: number) => void,
): void {
  let cursor = startMs;
  while (cursor < endMs) {
    const dateKey = kolkataDateKey(cursor);
    const [year, month, day] = dateKey.split("-").map(Number);
    const nextMidnight =
      Date.UTC(year, month - 1, day + 1) - KOLKATA_OFFSET_MS;
    const segmentEnd = Math.min(endMs, nextMidnight);
    add(dateKey, segmentEnd - cursor);
    cursor = segmentEnd;
  }
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
