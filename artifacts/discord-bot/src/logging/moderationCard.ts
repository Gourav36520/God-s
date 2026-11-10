import { spawn } from "node:child_process";
import { normalizeSeverity, severityColor } from "./presentation.js";

export interface ModerationCardDetail {
  label: string;
  value: string;
}

export interface ModerationCardOptions {
  action: string;
  targetName: string;
  targetUsername: string;
  targetId: string;
  targetAvatarUrl?: string;
  targetAvatarDataUrl?: string;
  moderatorName: string;
  moderatorUsername: string;
  moderatorId: string;
  severity?: unknown;
  reason?: string | null;
  duration?: string | null;
  expiresAt?: Date | number | string | null;
  details?: ModerationCardDetail[];
  timestamp?: Date | number;
  caseId?: number | string | null;
}

const CARD_WIDTH = 1_200;
const CARD_HEIGHT = 760;
const MAX_AVATAR_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 2_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const UNRATED_COLOR = "#5865f2";

function escapeXml(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0 ||
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      safe += "�";
    } else {
      safe += character;
    }
  }

  return safe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function units(value: string): number {
  return Array.from(value).reduce(
    (total, character) =>
      total + ((character.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1),
    0,
  );
}

function takeUnits(
  value: string,
  maxUnits: number,
): { head: string; tail: string } {
  const characters = Array.from(value);
  let width = 0;
  let index = 0;
  while (
    index < characters.length &&
    width + ((characters[index].codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1) <=
      maxUnits
  ) {
    width += (characters[index].codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
    index += 1;
  }
  return {
    head: characters.slice(0, index).join(""),
    tail: characters.slice(index).join(""),
  };
}

function shortLine(value: string, maxUnits: number): string {
  const shortened = takeUnits(value, maxUnits);
  return shortened.tail ? `${takeUnits(value, maxUnits - 1).head}…` : value;
}

function wrapText(
  value: string,
  maxUnits: number,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  const source = value
    .slice(0, 8_000)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ");
  const lines: string[] = [];

  for (const paragraph of source.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      let remaining = word;
      while (units(remaining) > maxUnits) {
        const chunk = takeUnits(remaining, maxUnits);
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(chunk.head);
        remaining = chunk.tail;
      }
      if (!remaining) continue;
      if (line && units(line) + units(remaining) + 1 > maxUnits) {
        lines.push(line);
        line = remaining;
      } else {
        line = line ? `${line} ${remaining}` : remaining;
      }
    }
    if (line) lines.push(line);
  }

  const truncated = lines.length > maxLines || value.length > 8_000;
  const visible = lines.slice(0, maxLines);
  if (truncated && visible.length) {
    visible[visible.length - 1] =
      `${takeUnits(visible[visible.length - 1], maxUnits - 1).head}…`;
  }
  return { lines: visible.length ? visible : ["(empty)"], truncated };
}

function lineMarkup(
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
): string {
  return lines
    .map(
      (line, index) =>
        `<tspan x="${x}" y="${y + index * lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");
}

function initials(name: string): string {
  const result = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
  return result || "?";
}

function severityAccent(value: unknown): string {
  const color = severityColor(value);
  return color === null
    ? UNRATED_COLOR
    : `#${color.toString(16).padStart(6, "0")}`;
}

function parseDate(
  value: Date | number | string | null | undefined,
): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function timestampLabel(value: Date | number | undefined): string {
  const date = parseDate(value ?? Date.now());
  if (!date) return "TIMESTAMP UNAVAILABLE";
  return `${new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  })
    .format(date)
    .toUpperCase()}`;
}

function expiryLabel(value: Date | number | string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return "Unavailable";
  return `${new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date)}`;
}

function safeAvatarDataUrl(value?: string): string | null {
  if (
    !value ||
    !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }
  return value;
}

function detailMarkup(
  label: string,
  value: string,
  x: number,
  y: number,
  accent: string,
): string {
  const lines = wrapText(value, 34, 1).lines;
  return `<rect x="${x}" y="${y}" width="344" height="76" rx="16" fill="#202434" stroke="#343a50" stroke-width="2"/>
    <rect x="${x}" y="${y}" width="5" height="76" rx="2" fill="${accent}"/>
    <text x="${x + 22}" y="${y + 26}" fill="#929bb6" font-family="DejaVu Sans, sans-serif" font-size="13" font-weight="700" letter-spacing="1.4">${escapeXml(shortLine(label.toUpperCase(), 24))}</text>
    <text x="${x + 22}" y="${y + 55}" fill="#f1f2fb" font-family="DejaVu Sans, sans-serif" font-size="18">${escapeXml(lines[0])}</text>`;
}

export function createModerationCardSvg(
  options: ModerationCardOptions,
): string {
  const severity = normalizeSeverity(options.severity);
  const accent = severityAccent(severity);
  const severityText = severity?.toUpperCase() ?? "UNRATED";
  const severityTextColor = severity === "critical" ? "#ffffff" : "#171922";
  const targetName = options.targetName.trim() || "Unknown user";
  const targetUsername =
    options.targetUsername.trim() || "Username unavailable";
  const moderatorName = options.moderatorName.trim() || "Moderator unavailable";
  const moderatorUsername =
    options.moderatorUsername.trim() || "Username unavailable";
  const targetAvatar = safeAvatarDataUrl(options.targetAvatarDataUrl);
  const avatarMarkup = targetAvatar
    ? `<image x="72" y="116" width="232" height="232" href="${targetAvatar}" preserveAspectRatio="xMidYMid slice" clip-path="url(#target-avatar-clip)"/>`
    : `<circle cx="188" cy="232" r="112" fill="#252a3d"/><text x="188" y="247" text-anchor="middle" fill="#aeb8ff" font-family="DejaVu Sans, sans-serif" font-size="48" font-weight="700">${escapeXml(initials(targetName))}</text>`;

  const reason = wrapText(
    options.reason?.trim() || "No reason provided",
    66,
    3,
  );
  const detailItems: ModerationCardDetail[] = [
    ...(options.duration
      ? [{ label: "Duration", value: options.duration }]
      : []),
    ...(options.expiresAt
      ? [{ label: "Expires", value: expiryLabel(options.expiresAt) }]
      : []),
    ...(options.details ?? []).filter(
      (detail) => detail.label.trim() && detail.value.trim(),
    ),
  ].slice(0, 4);
  const detailPositions = [
    [430, 504],
    [786, 504],
    [430, 594],
    [786, 594],
  ] as const;
  const detailMarkupContent = detailItems
    .map((detail, index) =>
      detailMarkup(
        detail.label,
        detail.value,
        detailPositions[index][0],
        detailPositions[index][1],
        accent,
      ),
    )
    .join("");
  const caseLabel =
    options.caseId !== null && options.caseId !== undefined
      ? `CASE #${options.caseId}`
      : "GODS BOT MODERATION";
  const truncatedNotice = reason.truncated
    ? `<text x="432" y="482" fill="#929bb6" font-family="DejaVu Sans, sans-serif" font-size="12" letter-spacing="1">REASON SHORTENED TO FIT</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#191c28"/>
      <stop offset="100%" stop-color="#141722"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#272c3d"/>
      <stop offset="100%" stop-color="#202434"/>
    </linearGradient>
    <clipPath id="target-avatar-clip"><circle cx="188" cy="232" r="108"/></clipPath>
  </defs>
  <rect width="1200" height="760" rx="30" fill="url(#background)"/>
  <path d="M25 220 L220 25 M95 300 L370 25 M855 25 L1165 335 M1015 25 L1175 185" fill="none" stroke="${accent}" stroke-opacity=".055" stroke-width="34"/>
  <rect x="20" y="20" width="1160" height="720" rx="28" fill="none" stroke="${accent}" stroke-width="5"/>
  <rect x="20" y="20" width="10" height="720" rx="5" fill="${accent}"/>
  <line x1="356" y1="70" x2="356" y2="690" stroke="#353b52" stroke-width="2"/>

  <text x="72" y="82" fill="#9da7d2" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">TARGET USER</text>
  ${avatarMarkup}
  <circle cx="188" cy="232" r="114" fill="none" stroke="${accent}" stroke-width="5"/>
  <text x="72" y="414" fill="#f5f6ff" font-family="DejaVu Sans, sans-serif" font-size="30" font-weight="700">${escapeXml(shortLine(targetName, 22))}</text>
  <text x="72" y="455" fill="#adb3c7" font-family="DejaVu Sans, sans-serif" font-size="21">${escapeXml(shortLine(targetUsername, 26))}</text>
  <text x="72" y="495" fill="#8991aa" font-family="DejaVu Sans, sans-serif" font-size="16">ID: ${escapeXml(shortLine(options.targetId || "Unavailable", 24))}</text>
  <rect x="72" y="612" width="228" height="42" rx="21" fill="#252b41" stroke="${accent}" stroke-opacity=".65" stroke-width="1"/>
  <circle cx="95" cy="633" r="6" fill="${accent}"/>
  <text x="112" y="639" fill="#c2c8dc" font-family="DejaVu Sans, sans-serif" font-size="13" font-weight="700" letter-spacing="1">MODERATION LOG</text>

  <text x="430" y="82" fill="#9da7d2" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">MODERATION ACTION</text>
  <rect x="962" y="48" width="178" height="50" rx="18" fill="${accent}"/>
  <text x="1051" y="80" text-anchor="middle" fill="${severityTextColor}" font-family="DejaVu Sans, sans-serif" font-size="19" font-weight="700" letter-spacing="1">${severityText}</text>
  <text x="430" y="140" fill="#f5f6ff" font-family="DejaVu Sans, sans-serif" font-size="31" font-weight="700">${escapeXml(shortLine(options.action.trim() || "Unknown action", 34).toUpperCase())}</text>

  <text x="430" y="194" fill="#929bb6" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="1.5">MODERATOR</text>
  <text x="430" y="230" fill="#f1f2fb" font-family="DejaVu Sans, sans-serif" font-size="21" font-weight="700">${escapeXml(shortLine(moderatorName, 34))}</text>
  <text x="430" y="261" fill="#adb3c7" font-family="DejaVu Sans, sans-serif" font-size="17">${escapeXml(shortLine(moderatorUsername, 36))}</text>
  <text x="790" y="261" fill="#8991aa" font-family="DejaVu Sans, sans-serif" font-size="16">ID: ${escapeXml(shortLine(options.moderatorId || "Unavailable", 24))}</text>
  <line x1="430" y1="282" x2="1140" y2="282" stroke="#353b52" stroke-width="2"/>

  <text x="430" y="317" fill="#929bb6" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="1.5">REASON</text>
  <rect x="430" y="335" width="710" height="142" rx="18" fill="url(#panel)" stroke="#343a50" stroke-width="2"/>
  <rect x="430" y="335" width="6" height="142" rx="3" fill="${accent}"/>
  <text fill="#f1f2fb" font-family="DejaVu Sans, sans-serif" font-size="20" xml:space="preserve">${lineMarkup(reason.lines, 462, 376, 30)}</text>
  ${truncatedNotice}
  ${detailMarkupContent}

  <text x="72" y="700" fill="#9ba4c2" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="1">${escapeXml(timestampLabel(options.timestamp))}</text>
  <text x="1140" y="700" text-anchor="end" fill="#9ba4c2" font-family="DejaVu Sans, sans-serif" font-size="14" letter-spacing="1">${escapeXml(shortLine(caseLabel, 34))}</text>
</svg>`;
}

async function fetchAvatarDataUrl(
  avatarUrl?: string,
): Promise<string | undefined> {
  if (!avatarUrl) return undefined;
  let url: URL;
  try {
    url = new URL(avatarUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com") {
    return undefined;
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
  if (!response.ok) return undefined;
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (!/^image\/(?:png|jpeg|webp)$/.test(contentType)) return undefined;
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_AVATAR_BYTES) return undefined;
  const image = Buffer.from(await response.arrayBuffer());
  if (!image.length || image.length > MAX_AVATAR_BYTES) return undefined;
  return `data:${contentType};base64,${image.toString("base64")}`;
}

function renderSvgToPng(svg: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const renderer = spawn("magick", ["svg:-", "png:-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let byteCount = 0;
    let errorByteCount = 0;
    let settled = false;

    const finish = (error?: Error, png?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (png) resolve(png);
      else reject(new Error("Moderation card renderer returned no image"));
    };
    const timeout = setTimeout(() => {
      renderer.kill("SIGKILL");
      finish(new Error("Moderation card rendering timed out"));
    }, 8_000);

    renderer.stdout.on("data", (chunk: Buffer) => {
      byteCount += chunk.length;
      if (byteCount > MAX_OUTPUT_BYTES) {
        renderer.kill("SIGKILL");
        finish(new Error("Moderation card image exceeded the size limit"));
      } else {
        chunks.push(chunk);
      }
    });
    renderer.stderr.on("data", (chunk: Buffer) => {
      if (errorByteCount >= 4_000) return;
      const kept = chunk.subarray(0, 4_000 - errorByteCount);
      errors.push(kept);
      errorByteCount += kept.length;
    });
    renderer.once("error", (error) => finish(error));
    renderer.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            `Moderation card renderer exited with code ${code}: ${Buffer.concat(errors).toString("utf8")}`,
          ),
        );
        return;
      }
      const png = Buffer.concat(chunks);
      if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        finish(new Error("Moderation card renderer did not return a PNG"));
        return;
      }
      finish(undefined, png);
    });
    renderer.stdin.on("error", () => {});
    renderer.stdin.end(svg);
  });
}

export async function renderModerationCard(
  options: ModerationCardOptions,
): Promise<Buffer> {
  const avatar = await fetchAvatarDataUrl(options.targetAvatarUrl).catch(
    () => undefined,
  );
  return renderSvgToPng(
    createModerationCardSvg({
      ...options,
      targetAvatarDataUrl: avatar,
    }),
  );
}
