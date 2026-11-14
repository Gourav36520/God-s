export const LEVEL_CLASSES = [
  "Poor Class",
  "Middle Poor",
  "High Poor",
  "Low Middle Class",
  "Middle Class",
  "High Middle Class",
  "Rich Class",
  "Middle Rich",
  "High Rich",
  "Millionaire",
  "Centimillionaire",
  "Billionaire",
  "Multimillionaire",
  "Trillionaire",
  "Infinity",
] as const;

const XP_PER_LEVEL_MULTIPLIER = 100n;

export interface LevelProgress {
  level: number;
  className: string;
  nextClassName: string | null;
  xpIntoLevel: bigint;
  xpRequiredForNextLevel: bigint;
}

export function xpToReachLevel(level: bigint): bigint {
  if (level <= 1n) return 0n;
  return (XP_PER_LEVEL_MULTIPLIER * (level - 1n) * level) / 2n;
}

export function classNameForLevel(level: number): string {
  if (!Number.isSafeInteger(level) || level < 1) return LEVEL_CLASSES[0];
  return LEVEL_CLASSES[Math.min(level - 1, LEVEL_CLASSES.length - 1)]!;
}

export function calculateLevelProgress(totalXp: bigint): LevelProgress {
  const safeTotal = totalXp > 0n ? totalXp : 0n;
  let low = 1n;
  let high = 2n;

  while (xpToReachLevel(high) <= safeTotal) {
    low = high;
    high *= 2n;
  }
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if (xpToReachLevel(middle) <= safeTotal) low = middle;
    else high = middle;
  }

  const level = Number(low);
  const baseXp = xpToReachLevel(low);
  const nextClassName =
    level < LEVEL_CLASSES.length ? classNameForLevel(level + 1) : null;

  return {
    level,
    className: classNameForLevel(level),
    nextClassName,
    xpIntoLevel: safeTotal - baseXp,
    xpRequiredForNextLevel: XP_PER_LEVEL_MULTIPLIER * low,
  };
}

export function formatCompactXp(xp: bigint): string {
  const absoluteXp = xp < 0n ? -xp : xp;
  for (const [unit, suffix] of [
    [1_000_000_000_000_000_000n, "E"],
    [1_000_000_000_000_000n, "Q"],
    [1_000_000_000_000n, "T"],
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ] as const) {
    if (absoluteXp < unit) continue;
    const tenths = (absoluteXp * 10n + unit / 2n) / unit;
    return `${xp < 0n ? "-" : ""}${tenths / 10n}.${tenths % 10n}${suffix}`;
  }
  return `${xp}`;
}
