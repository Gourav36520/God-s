import type { GuildMember } from "discord.js";
import {
  loadAvatarDataUrl,
  renderSvgToPng,
} from "../logging/profileAndDeleteCards.js";
import type { MemberProfileChange } from "./types.js";

const WIDTH = 1_200;
const HEIGHT = 760;
const CYAN = "#50e4ff";
const PALE_CYAN = "#b8f7ff";
const WHITE = "#edfaff";
const MUTED = "#a7c5e2";
const PANEL = "#071d43";
const INNER = "#0b2857";

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized || "Unavailable";
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "Unavailable";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatFieldName(field: "username" | "displayName" | "nickname"): string {
  if (field === "username") return "Username";
  if (field === "displayName") return "Display name";
  return "Server nickname";
}

function shell(definitions: string, content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="night" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#041b43"/>
      <stop offset="55%" stop-color="#031333"/>
      <stop offset="100%" stop-color="#020b22"/>
    </linearGradient>
    <linearGradient id="card-panel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a2858"/>
      <stop offset="100%" stop-color="#061a3e"/>
    </linearGradient>
    <radialGradient id="glow">
      <stop offset="0%" stop-color="#39cfff" stop-opacity=".23"/>
      <stop offset="100%" stop-color="#39cfff" stop-opacity="0"/>
    </radialGradient>
    ${definitions}
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="30" fill="url(#night)"/>
  <ellipse cx="155" cy="122" rx="300" ry="220" fill="url(#glow)"/>
  <ellipse cx="1060" cy="690" rx="260" ry="200" fill="url(#glow)"/>
  <path d="M30 270 L285 20 M895 20 L1170 292 M920 740 L1180 485" fill="none" stroke="#38cfff" stroke-opacity=".09" stroke-width="22"/>
  <circle cx="84" cy="102" r="2.8" fill="${PALE_CYAN}"/>
  <circle cx="279" cy="80" r="2" fill="${CYAN}"/>
  <circle cx="1110" cy="90" r="2.5" fill="${PALE_CYAN}"/>
  <circle cx="1130" cy="675" r="3" fill="${CYAN}"/>
  <path d="M115 55 C68 68 49 112 72 151 C38 137 28 92 50 63 C67 40 94 33 115 55Z" fill="#47d9ff" fill-opacity=".8"/>
  <rect x="24" y="24" width="1152" height="712" rx="26" fill="none" stroke="${CYAN}" stroke-width="4"/>
  <rect x="31" y="31" width="1138" height="698" rx="22" fill="none" stroke="#a7f4ff" stroke-opacity=".18" stroke-width="1"/>
  ${content}
  <path d="M1124 700 l12 -22 12 22 22 12 -22 12 -12 22 -12 -22 -22 -12z" fill="${CYAN}" fill-opacity=".72"/>
  </svg>`;
}

function panel(
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 20,
): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="url(#card-panel)" stroke="#2b73a9" stroke-opacity=".8" stroke-width="2"/>
  <rect x="${x + 4}" y="${y + 4}" width="${width - 8}" height="${height - 8}" rx="${radius - 3}" fill="none" stroke="#65e5ff" stroke-opacity=".12" stroke-width="1"/>`;
}

function field(
  label: string,
  value: string,
  x: number,
  y: number,
  maxLength = 38,
): string {
  return `<text x="${x}" y="${y}" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="16" letter-spacing="1.4">${escapeXml(label.toUpperCase())}</text>
  <text x="${x}" y="${y + 33}" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="23">${escapeXml(oneLine(value, maxLength))}</text>`;
}

function avatarMarkup(
  dataUrl: string | undefined,
  centerX: number,
  centerY: number,
  radius: number,
  clipId: string,
  fallback: string,
): string {
  const safeDataUrl =
    dataUrl &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)
      ? dataUrl
      : null;
  const image = safeDataUrl
    ? `<image x="${centerX - radius}" y="${centerY - radius}" width="${radius * 2}" height="${radius * 2}" href="${safeDataUrl}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
    : `<circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="#092a56"/><text x="${centerX}" y="${centerY + 10}" text-anchor="middle" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="28">${escapeXml(fallback)}</text>`;
  return `${image}<circle cx="${centerX}" cy="${centerY}" r="${radius + 4}" fill="none" stroke="${CYAN}" stroke-width="4"/>`;
}

function initials(value: string): string {
  return (
    value
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}

export async function renderMemberProfileCard(
  member: GuildMember,
  departedAt: string | null = null,
): Promise<Buffer> {
  const avatar = await loadAvatarDataUrl(
    member.user.displayAvatarURL({ extension: "png", size: 256 }),
  ).catch(() => undefined);
  const roles = member.roles.cache.filter((role) => role.id !== member.guild.id);
  const highestRole =
    member.roles.highest.id === member.guild.id
      ? "Member"
      : member.roles.highest.name;
  const timeout = member.communicationDisabledUntil;
  const content = `
    <text x="74" y="79" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="700" letter-spacing="3">MEMBER PROFILE</text>
    <line x1="74" y1="96" x2="242" y2="96" stroke="${CYAN}" stroke-width="3"/>
    <line x1="405" y1="116" x2="405" y2="680" stroke="#47cfff" stroke-opacity=".35" stroke-width="2"/>
    <defs><clipPath id="profile-avatar"><circle cx="230" cy="245" r="118"/></clipPath></defs>
    ${avatarMarkup(avatar, 230, 245, 118, "profile-avatar", initials(member.displayName))}
    <text x="78" y="422" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="16" letter-spacing="2">SERVER</text>
    <text x="78" y="456" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="25">${escapeXml(oneLine(member.guild.name, 24))}</text>
    <text x="78" y="514" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="16" letter-spacing="2">DISCORD NAME</text>
    <text x="78" y="549" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="24">${escapeXml(oneLine(member.displayName, 25))}</text>
    <text x="78" y="600" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="16" letter-spacing="2">USERNAME · ID</text>
    <text x="78" y="635" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="18">${escapeXml(oneLine(`@${member.user.username}  ·  ${member.id}`, 34))}</text>
    ${panel(442, 128, 324, 132, 18)}
    ${panel(790, 128, 324, 132, 18)}
    ${field("Account created", formatDate(member.user.createdAt), 470, 174, 23)}
    ${field("Joined server", formatDate(member.joinedAt), 818, 174, 23)}
    ${panel(442, 278, 672, 132, 18)}
    <text x="470" y="323" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="16" letter-spacing="1.4">HIGHEST ROLE</text>
    <text x="470" y="364" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="25">${escapeXml(oneLine(highestRole, 37))}</text>
    <line x1="858" y1="300" x2="858" y2="386" stroke="#55dfff" stroke-opacity=".5" stroke-width="2"/>
    <text x="892" y="323" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="16" letter-spacing="1.4">SERVER ROLES</text>
    <text x="892" y="365" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="32">${roles.size.toLocaleString()}</text>
    ${panel(442, 428, 324, 132, 18)}
    ${panel(790, 428, 324, 132, 18)}
    ${field("Server boost", formatDate(member.premiumSince), 470, 474, 22)}
    ${field(
      "Timeout",
      timeout ? `Until ${formatDate(timeout)}` : "None",
      818,
      474,
      22,
    )}
    ${departedAt ? panel(442, 578, 672, 70, 16) : ""}
    ${
      departedAt
        ? `<text x="470" y="622" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="19">Former member · left ${escapeXml(formatDate(departedAt))}</text>`
        : `<text x="442" y="629" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="16" letter-spacing="1.3">SERVER PROFILE · DETAILS AVAILABLE THROUGH DISCORD</text>`
    }
  `;
  return renderSvgToPng(shell("", content));
}

export async function renderMemberHistoryCard(
  member: GuildMember,
  changes: MemberProfileChange[],
): Promise<Buffer> {
  const orderedChanges = [...changes].sort(
    (left, right) =>
      new Date(right.occurredAt).getTime() -
      new Date(left.occurredAt).getTime(),
  );
  const nameChanges = orderedChanges.filter(
    (change): change is Extract<MemberProfileChange, { kind: "name" }> =>
      change.kind === "name",
  );
  const avatarChanges = orderedChanges.filter(
    (change): change is Extract<MemberProfileChange, { kind: "avatar" }> =>
      change.kind === "avatar",
  );
  const latestName = nameChanges[0];
  const recentNames = nameChanges.slice(1, 3);
  const recentAvatars = avatarChanges.slice(0, 2);
  const avatarRows = await Promise.all(
    recentAvatars.map(async (change, index) => {
      const [previous, next] = await Promise.all([
        loadAvatarDataUrl(change.previousValue ?? undefined).catch(
          () => undefined,
        ),
        loadAvatarDataUrl(change.newValue ?? undefined).catch(
          () => undefined,
        ),
      ]);
      return { change, index, previous, next };
    }),
  );
  const avatarDefs = avatarRows
    .map(
      ({ index }) => `
        <clipPath id="before-avatar-${index}"><circle cx="340" cy="${538 + index * 104}" r="43"/></clipPath>
        <clipPath id="after-avatar-${index}"><circle cx="520" cy="${538 + index * 104}" r="43"/></clipPath>`,
    )
    .join("");
  const earlierNamesMarkup = recentNames
    .map(
      (change, index) => `
        <text x="96" y="${324 + index * 18}" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="13">${escapeXml(oneLine(`${formatFieldName(change.field)}: ${change.previousValue} → ${change.newValue} · ${formatDate(change.occurredAt)}`, 108))}</text>`,
    )
    .join("");
  const avatarRowsMarkup = avatarRows.length
    ? avatarRows
        .map(
          ({ change, index, previous, next }) => {
            const y = 538 + index * 104;
            return `
              ${avatarMarkup(previous, 340, y, 43, `before-avatar-${index}`, "OLD")}
              <path d="M412 ${y} H448 M437 ${y - 12} L449 ${y} L437 ${y + 12}" fill="none" stroke="${CYAN}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
              ${avatarMarkup(next, 520, y, 43, `after-avatar-${index}`, "NEW")}
              <text x="760" y="${y + 7}" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="19">${escapeXml(formatDate(change.occurredAt))}</text>
              ${index === 0 && avatarChanges.length > 1 ? `<text x="990" y="${y + 7}" text-anchor="end" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="14">LATEST</text>` : ""}`;
          },
        )
        .join("")
    : `<text x="180" y="566" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="22">No history recorded</text>`;
  const content = `
    <text x="72" y="76" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="2.2">DISCORD NAME / ID</text>
    <text x="72" y="112" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="25">${escapeXml(oneLine(`${member.displayName}  ·  @${member.user.username}`, 54))}</text>
    <text x="1105" y="108" text-anchor="end" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="15">${escapeXml(member.id)}</text>
    ${panel(52, 140, 1096, 220, 22)}
    <text x="86" y="184" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="21" font-weight="700" letter-spacing="3">NAME CHANGE</text>
    <line x1="86" y1="201" x2="282" y2="201" stroke="${CYAN}" stroke-width="3"/>
    <text x="96" y="242" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1.3">${escapeXml(latestName ? formatFieldName(latestName.field).toUpperCase() : "HISTORY")}</text>
    <text x="96" y="283" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="22">${escapeXml(oneLine(latestName?.previousValue ?? "No history recorded", 29))}</text>
    <path d="M485 265 H526 M511 251 L527 265 L511 279" fill="none" stroke="${CYAN}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="548" y="242" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1.3">CURRENT</text>
    <text x="548" y="283" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="22">${escapeXml(oneLine(latestName?.newValue ?? "No history recorded", 30))}</text>
    <line x1="900" y1="224" x2="900" y2="324" stroke="#55dfff" stroke-opacity=".45" stroke-width="2"/>
    <text x="930" y="250" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1.3">CHANGED</text>
    <text x="930" y="286" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="19">${escapeXml(latestName ? formatDate(latestName.occurredAt) : "No history recorded")}</text>
    ${earlierNamesMarkup}

    ${panel(52, 384, 1096, 326, 22)}
    <text x="86" y="430" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="21" font-weight="700" letter-spacing="3">AVATAR CHANGE</text>
    <line x1="86" y1="447" x2="316" y2="447" stroke="${CYAN}" stroke-width="3"/>
    <text x="340" y="486" text-anchor="middle" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="14" letter-spacing="1.4">PREVIOUS</text>
    <text x="520" y="486" text-anchor="middle" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="14" letter-spacing="1.4">NEW</text>
    <text x="760" y="486" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="14" letter-spacing="1.4">CHANGED</text>
    <line x1="710" y1="496" x2="710" y2="682" stroke="#55dfff" stroke-opacity=".45" stroke-width="2"/>
    ${avatarRowsMarkup}
    <text x="1105" y="684" text-anchor="end" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="13" letter-spacing="1">LATEST CHANGES FIRST · ALL RECORDS STORED</text>
  `;
  return renderSvgToPng(shell(avatarDefs, content));
}

function ageRoleLabel(member: GuildMember): string {
  const normalize = (name: string) =>
    name.replace(/\s+/g, "").replace(/[−–]/g, "-").toLowerCase();
  const roleNames = member.roles.cache
    .filter((role) => role.id !== member.guild.id)
    .map((role) => normalize(role.name));
  const hasPlus = roleNames.includes("18+");
  const hasMinus = roleNames.includes("18-");
  if (hasPlus && hasMinus) return "Check roles";
  if (hasPlus) return "18+";
  if (hasMinus) return "18−";
  return "Not set";
}

export function renderMemberRolesCard(
  member: GuildMember,
  violationCount: number | null,
  departedAt: string | null = null,
): Promise<Buffer> {
  const roles = member.roles.cache
    .filter((role) => role.id !== member.guild.id)
    .sort((left, right) => right.position - left.position);
  const visibleRoles = [...roles.values()].slice(0, 20);
  const rolesMarkup = visibleRoles.length
    ? visibleRoles
        .map((role, index) => {
          const col = index % 4;
          const row = Math.floor(index / 4);
          const x = 100 + col * 264;
          const y = 424 + row * 52;
          const accent = role.hexColor && role.hexColor !== "#000000"
            ? role.hexColor
            : CYAN;
          return `<rect x="${x}" y="${y}" width="244" height="38" rx="19" fill="#092750" stroke="${escapeXml(accent)}" stroke-opacity=".8" stroke-width="1.5"/>
            <circle cx="${x + 18}" cy="${y + 19}" r="6" fill="${escapeXml(accent)}"/>
            <text x="${x + 34}" y="${y + 25}" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="16">${escapeXml(oneLine(role.name, 23))}</text>`;
        })
        .join("")
    : `<text x="100" y="464" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="20">No additional roles</text>`;
  const overflow = Math.max(0, roles.size - visibleRoles.length);
  const violationLabel =
    violationCount === null
      ? "Unavailable"
      : violationCount === 0
        ? "None recorded"
        : `${violationCount.toLocaleString()} recorded`;
  const content = `
    <text x="72" y="76" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="2.2">DISCORD NAME / ID</text>
    <text x="72" y="112" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="25">${escapeXml(oneLine(`${member.displayName}  ·  @${member.user.username}`, 54))}</text>
    <text x="1105" y="108" text-anchor="end" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="15">${escapeXml(member.id)}</text>
    ${panel(52, 140, 518, 184, 22)}
    ${panel(590, 140, 558, 184, 22)}
    <path d="M97 198 L124 181 L151 198 V239 Q151 265 124 279 Q97 265 97 239Z" fill="none" stroke="${CYAN}" stroke-width="4"/>
    <text x="124" y="238" text-anchor="middle" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="700">18+</text>
    <text x="174" y="190" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="700" letter-spacing="2.6">AGE ROLE</text>
    <line x1="174" y1="207" x2="344" y2="207" stroke="${CYAN}" stroke-width="3"/>
    <text x="174" y="268" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="42">${escapeXml(ageRoleLabel(member))}</text>
    <text x="370" y="266" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="15">ROLE-BASED</text>
    <path d="M630 184 L664 244 H596Z" fill="none" stroke="${CYAN}" stroke-width="4" stroke-linejoin="round"/>
    <line x1="630" y1="203" x2="630" y2="222" stroke="${CYAN}" stroke-width="4" stroke-linecap="round"/>
    <circle cx="630" cy="233" r="2.5" fill="${CYAN}"/>
    <text x="690" y="190" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="700" letter-spacing="2.6">VIOLATIONS</text>
    <line x1="690" y1="207" x2="890" y2="207" stroke="${CYAN}" stroke-width="3"/>
    <circle cx="704" cy="256" r="15" fill="none" stroke="${CYAN}" stroke-width="3"/>
    <path d="M697 256 L702 261 L712 250" fill="none" stroke="${CYAN}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="736" y="265" fill="${WHITE}" font-family="DejaVu Sans, sans-serif" font-size="23">${escapeXml(violationLabel)}</text>
    <text x="690" y="296" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="13">FROM RECORDED HEAT VIOLATIONS AND MODERATION CASES</text>
    ${panel(52, 348, 1096, 330, 22)}
    <text x="96" y="395" fill="${PALE_CYAN}" font-family="DejaVu Sans, sans-serif" font-size="21" font-weight="700" letter-spacing="3">SERVER ROLES</text>
    <text x="1100" y="395" text-anchor="end" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="17">${roles.size.toLocaleString()} CURRENT</text>
    <line x1="96" y1="411" x2="272" y2="411" stroke="${CYAN}" stroke-width="3"/>
    ${rolesMarkup}
    ${overflow > 0 ? `<text x="100" y="695" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="14">+${overflow} more role${overflow === 1 ? "" : "s"} not shown</text>` : ""}
    <text x="1100" y="696" text-anchor="end" fill="${MUTED}" font-family="DejaVu Sans, sans-serif" font-size="13">${departedAt ? `FORMER MEMBER · LEFT ${escapeXml(formatDate(departedAt)).toUpperCase()}` : "AGE LABEL IS BASED ONLY ON SERVER ROLES · NOT VERIFIED AGE"}</text>
  `;
  return renderSvgToPng(shell("", content));
}
