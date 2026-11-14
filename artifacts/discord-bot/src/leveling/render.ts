import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { GuildMember } from "discord.js";
import {
  loadAvatarDataUrl,
  renderSvgToPng,
} from "../logging/profileAndDeleteCards.js";
import { calculateLevelProgress, formatCompactXp } from "./progression.js";

const WIDTH = 1_024;
const HEIGHT = 576;
const GOLD = "#ffd94f";
const PALE_GOLD = "#fff2b5";
const WHITE = "#f5f6fb";
const MUTED = "#d9d4bf";
const BACKGROUND_PATH = fileURLToPath(
  new URL(
    "../../../../attached_assets/0_94bf9a62-54d9-481b-9983-ac502a3ff1db_1794661868806.jpg",
    import.meta.url,
  ),
);

export interface LevelCardProfile {
  totalXp: bigint;
  recentXp: bigint;
  rank: number;
}

let backgroundDataUrl: Promise<string> | null = null;

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clipped(value: string, maxLength: number): string {
  const safe = value.replace(/\s+/g, " ").trim();
  if (safe.length <= maxLength) return safe;
  return `${safe.slice(0, maxLength - 1)}…`;
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase() || "?";
}

async function getBackgroundDataUrl(): Promise<string> {
  backgroundDataUrl ??= readFile(BACKGROUND_PATH).then(
    (image) => `data:image/jpeg;base64,${image.toString("base64")}`,
  );
  return backgroundDataUrl;
}

function classChipText(value: string): string {
  const fontSize =
    value.length > 15 ? 13 : value.length > 11 ? 15 : value.length > 8 ? 17 : 21;
  return `<text x="403" y="367" text-anchor="middle" fill="${GOLD}" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing=".5">${escapeXml(value.toUpperCase())}</text>`;
}

function classTransition(
  currentClass: string,
  nextClass: string | null,
): string {
  if (!nextClass) {
    return `<text x="512" y="513" text-anchor="middle" fill="${GOLD}" font-family="DejaVu Sans, sans-serif" font-size="19" font-weight="700" letter-spacing="1.5">INFINITY · NO HIGHER CLASS</text>`;
  }
  const currentFont = currentClass.length > 14 ? 13 : currentClass.length > 10 ? 15 : 18;
  const nextFont = nextClass.length > 14 ? 13 : nextClass.length > 10 ? 15 : 18;
  return `<text x="410" y="513" text-anchor="middle" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="${currentFont}" font-weight="700" letter-spacing="1">${escapeXml(currentClass.toUpperCase())}</text>
  <text x="510" y="513" text-anchor="middle" fill="${GOLD}" font-family="DejaVu Sans, sans-serif" font-size="27" font-weight="700">→</text>
  <text x="625" y="513" text-anchor="middle" fill="${GOLD}" font-family="DejaVu Sans, sans-serif" font-size="${nextFont}" font-weight="700" letter-spacing="1">${escapeXml(nextClass.toUpperCase())}</text>`;
}

export async function renderLevelCard(
  member: GuildMember,
  profile: LevelCardProfile,
): Promise<Buffer> {
  const progress = calculateLevelProgress(profile.totalXp);
  const background = await getBackgroundDataUrl();
  const avatar = await loadAvatarDataUrl(
    member.displayAvatarURL({ extension: "png", size: 256 }),
  );
  const fillWidth = Number(
    (progress.xpIntoLevel * 514n) /
      (progress.xpRequiredForNextLevel || 1n),
  );
  const card = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <clipPath id="level-avatar-clip"><circle cx="140" cy="240" r="49"/></clipPath>
    <linearGradient id="level-bar-fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff084"/>
      <stop offset="55%" stop-color="#ffd739"/>
      <stop offset="100%" stop-color="#e8a819"/>
    </linearGradient>
  </defs>
  <image href="${background}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}"/>
  <rect x="54" y="302" width="205" height="38" rx="4" fill="#02040d"/>
  <rect x="334" y="103" width="490" height="113" rx="8" fill="#02040d"/>
  <rect x="329" y="339" width="143" height="41" rx="4" fill="#030713"/>
  <rect x="560" y="348" width="126" height="39" rx="3" fill="#030713"/>
  <rect x="822" y="348" width="102" height="39" rx="3" fill="#030713"/>
  <rect x="335" y="488" width="350" height="39" rx="4" fill="#02040d"/>
  <circle cx="140" cy="240" r="53" fill="#080c17"/>
  ${avatar
    ? `<image href="${avatar}" x="91" y="191" width="98" height="98" preserveAspectRatio="xMidYMid slice" clip-path="url(#level-avatar-clip)"/>`
    : `<text x="140" y="248" text-anchor="middle" fill="${PALE_GOLD}" font-family="DejaVu Sans, sans-serif" font-size="26" font-weight="700">${escapeXml(initials(member.user.username))}</text>`}
  <circle cx="140" cy="240" r="52" fill="none" stroke="${GOLD}" stroke-width="4"/>
  <text x="63" y="329" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="19" font-weight="700" letter-spacing=".6">${escapeXml(clipped(member.user.username, 18))}</text>
  <text x="63" y="359" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="13" font-weight="700" letter-spacing="1">LEVEL ${progress.level.toLocaleString()}</text>
  <text x="580" y="191" text-anchor="middle" fill="${GOLD}" font-family="DejaVu Sans, sans-serif" font-size="89" font-weight="700" letter-spacing="1">+${escapeXml(formatCompactXp(profile.recentXp))}</text>
  ${classChipText(progress.className)}
  <text x="623" y="375" text-anchor="middle" fill="${GOLD}" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="700">${escapeXml(formatCompactXp(profile.totalXp))}</text>
  <text x="873" y="375" text-anchor="middle" fill="${GOLD}" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="700">#${profile.rank.toLocaleString()}</text>
  <text x="905" y="418" text-anchor="end" fill="${PALE_GOLD}" font-family="DejaVu Sans, sans-serif" font-size="12" font-weight="700">${escapeXml(`${formatCompactXp(progress.xpIntoLevel)} / ${formatCompactXp(progress.xpRequiredForNextLevel)} XP`)}</text>
  <rect x="391" y="426" width="522" height="17" rx="8.5" fill="#111a2e" stroke="#566079" stroke-width="1.5"/>
  ${fillWidth > 0 ? `<rect x="394" y="429" width="${Math.min(fillWidth, 514)}" height="11" rx="5.5" fill="url(#level-bar-fill)"/>` : ""}
  ${classTransition(progress.className, progress.nextClassName)}
  </svg>`;

  return renderSvgToPng(card);
}
