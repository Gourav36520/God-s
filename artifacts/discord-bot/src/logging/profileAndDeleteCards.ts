import { spawn } from "node:child_process";

interface ProfileCardOptions {
  authorName: string;
  authorTag: string;
  authorId: string;
  avatarUrl?: string;
}

export interface NameChangeCardOptions extends ProfileCardOptions {
  beforeName: string;
  afterName: string;
  beforeTag: string;
  afterTag: string;
}

export interface AvatarChangeCardOptions extends ProfileCardOptions {
  beforeAvatarUrl?: string;
  afterAvatarUrl?: string;
}

export interface MessageDeleteCardOptions extends ProfileCardOptions {
  content: string;
}

const CARD_WIDTH = 1_200;
const CARD_HEIGHT = 760;
const MAX_SOURCE_CHARS = 12_000;
const MAX_LINE_UNITS = 52;
const MAX_AVATAR_BYTES = 1_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function escapeXml(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0 ||
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
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

function characterUnits(character: string): number {
  return (character.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
}

function units(value: string): number {
  return Array.from(value).reduce(
    (total, character) => total + characterUnits(character),
    0,
  );
}

function takeUnits(value: string, maxUnits: number): { head: string; tail: string } {
  const characters = Array.from(value);
  let index = 0;
  let width = 0;
  while (
    index < characters.length &&
    width + characterUnits(characters[index]) <= maxUnits
  ) {
    width += characterUnits(characters[index]);
    index += 1;
  }
  return {
    head: characters.slice(0, index).join(""),
    tail: characters.slice(index).join(""),
  };
}

function wrapText(
  value: string,
  maxLines: number,
  maxUnits = MAX_LINE_UNITS,
): { lines: string[]; truncated: boolean } {
  const source = value
    .slice(0, MAX_SOURCE_CHARS)
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

  const truncated = lines.length > maxLines || value.length > MAX_SOURCE_CHARS;
  const visible = lines.slice(0, maxLines);
  if (truncated && visible.length) {
    const last = takeUnits(visible[visible.length - 1], maxUnits - 1);
    visible[visible.length - 1] = `${last.head}…`;
  }
  return { lines: visible.length ? visible : ["(empty)"], truncated };
}

function shortLine(value: string, maxUnits: number): string {
  const shortened = takeUnits(value, maxUnits);
  return shortened.tail ? `${takeUnits(value, maxUnits - 1).head}…` : value;
}

function initials(value: string): string {
  const result = value
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
  return result || "?";
}

function safeImageDataUrl(value?: string): string | null {
  return value &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value
    : null;
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

function avatarMarkup(
  dataUrl: string | undefined,
  x: number,
  y: number,
  size: number,
  clipId: string,
  clipCenterX: number,
  clipCenterY: number,
  clipRadius: number,
  fallback: string,
): string {
  const safeImage = safeImageDataUrl(dataUrl);
  if (safeImage) {
    return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="${safeImage}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`;
  }
  return `<circle cx="${clipCenterX}" cy="${clipCenterY}" r="${clipRadius}" fill="#252a3d"/><text x="${clipCenterX}" y="${clipCenterY + 12}" text-anchor="middle" fill="#aeb8ff" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="700">${escapeXml(fallback)}</text>`;
}

function svgShell(definitions: string, body: string): string {
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
    ${definitions}
  </defs>
  <rect width="1200" height="760" rx="30" fill="url(#background)"/>
  <path d="M25 220 L220 25 M95 300 L370 25 M855 25 L1165 335 M1015 25 L1175 185" fill="none" stroke="#5865f2" stroke-opacity=".045" stroke-width="34"/>
  <rect x="20" y="20" width="1160" height="720" rx="28" fill="none" stroke="#7784ff" stroke-width="5"/>
  <line x1="356" y1="70" x2="356" y2="690" stroke="#353b52" stroke-width="2"/>
  ${body}
</svg>`;
}

function profileMarkup(
  profile: ProfileCardOptions,
  avatarDataUrl?: string,
): string {
  return `<text x="72" y="82" fill="#9da7d2" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">PROFILE</text>
  ${avatarMarkup(avatarDataUrl, 90, 132, 164, "profile-avatar-clip", 172, 214, 81, initials(profile.authorName))}
  <circle cx="172" cy="214" r="84" fill="none" stroke="#8490ff" stroke-width="5"/>
  <text x="72" y="354" fill="#f5f6ff" font-family="DejaVu Sans, sans-serif" font-size="30" font-weight="700">${escapeXml(shortLine(profile.authorName, 16))}</text>
  <text x="72" y="396" fill="#adb3c7" font-family="DejaVu Sans, sans-serif" font-size="21">${escapeXml(shortLine(profile.authorTag, 22))}</text>
  <text x="72" y="440" fill="#8991aa" font-family="DejaVu Sans, sans-serif" font-size="17">ID: ${escapeXml(profile.authorId)}</text>`;
}

async function loadAvatarDataUrl(avatarUrl?: string): Promise<string | undefined> {
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
  const size = Number(response.headers.get("content-length") ?? 0);
  if (size > MAX_AVATAR_BYTES) return undefined;

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
    let bytes = 0;
    let errorBytes = 0;
    let settled = false;
    const finish = (error?: Error, png?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (png) resolve(png);
      else reject(new Error("Card renderer returned no image"));
    };
    const timeout = setTimeout(() => {
      renderer.kill("SIGKILL");
      finish(new Error("Card rendering timed out"));
    }, 8_000);

    renderer.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        renderer.kill("SIGKILL");
        finish(new Error("Rendered card exceeded the size limit"));
      } else {
        chunks.push(chunk);
      }
    });
    renderer.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= 4_000) return;
      const kept = chunk.subarray(0, 4_000 - errorBytes);
      errors.push(kept);
      errorBytes += kept.length;
    });
    renderer.once("error", (error) => finish(error));
    renderer.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            `Card renderer exited with code ${code}: ${Buffer.concat(errors).toString("utf8")}`,
          ),
        );
        return;
      }
      const png = Buffer.concat(chunks);
      if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        finish(new Error("Card renderer did not return a PNG"));
        return;
      }
      finish(undefined, png);
    });
    renderer.stdin.on("error", () => {});
    renderer.stdin.end(svg);
  });
}

export function createNameChangeCardSvg(
  options: NameChangeCardOptions,
  profileAvatar?: string,
): string {
  const beforeName = wrapText(options.beforeName, 2, 40);
  const afterName = wrapText(options.afterName, 2, 40);
  const beforeTag = shortLine(options.beforeTag, 24);
  const afterTag = shortLine(options.afterTag, 24);
  const definitions =
    '<clipPath id="profile-avatar-clip"><circle cx="172" cy="214" r="81"/></clipPath>';
  const body = `${profileMarkup(options, profileAvatar)}
  <rect x="72" y="612" width="210" height="42" rx="21" fill="#252b41" stroke="#3e4771" stroke-width="1"/>
  <circle cx="95" cy="633" r="6" fill="#8490ff"/>
  <text x="112" y="639" fill="#b6beff" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="1">NAME CHANGE</text>

  <text x="410" y="83" fill="#9da7d2" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">PROFILE NAME</text>
  <text x="410" y="137" fill="#aeb3c7" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="700" letter-spacing="2">BEFORE</text>
  <rect x="410" y="158" width="730" height="136" rx="20" fill="url(#panel)" stroke="#343a50" stroke-width="2"/>
  <rect x="410" y="158" width="6" height="136" rx="3" fill="#6d78e8"/>
  <text fill="#f1f2fb" font-family="DejaVu Sans, sans-serif" font-size="28" font-weight="700">${lineMarkup(beforeName.lines, 444, 218, 36)}</text>

  <path d="M775 323 V367 M758 350 L775 367 L792 350" fill="none" stroke="#8792ff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>

  <text x="410" y="421" fill="#8792ff" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="700" letter-spacing="2">AFTER</text>
  <rect x="410" y="442" width="730" height="136" rx="20" fill="url(#panel)" stroke="#414a74" stroke-width="2"/>
  <rect x="410" y="442" width="6" height="136" rx="3" fill="#8792ff"/>
  <text fill="#f1f2fb" font-family="DejaVu Sans, sans-serif" font-size="28" font-weight="700">${lineMarkup(afterName.lines, 444, 502, 36)}</text>

  <rect x="410" y="620" width="300" height="52" rx="15" fill="#24293b"/>
  <text x="432" y="653" fill="#c4c9db" font-family="DejaVu Sans, sans-serif" font-size="18">${escapeXml(beforeTag)}</text>
  <path d="M758 646 H792 M781 635 L793 646 L781 657" fill="none" stroke="#8792ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="830" y="620" width="310" height="52" rx="15" fill="#252b41" stroke="#414a74" stroke-width="1"/>
  <text x="852" y="653" fill="#b9c1ff" font-family="DejaVu Sans, sans-serif" font-size="18">${escapeXml(afterTag)}</text>`;
  return svgShell(definitions, body);
}

export function createAvatarChangeCardSvg(
  options: AvatarChangeCardOptions,
  profileAvatar?: string,
  beforeAvatar?: string,
  afterAvatar?: string,
): string {
  const definitions = `
    <clipPath id="profile-avatar-clip"><circle cx="172" cy="214" r="81"/></clipPath>
    <clipPath id="before-avatar-clip"><circle cx="580" cy="355" r="116"/></clipPath>
    <clipPath id="after-avatar-clip"><circle cx="970" cy="355" r="116"/></clipPath>`;
  const body = `${profileMarkup(options, profileAvatar)}
  <rect x="72" y="612" width="210" height="42" rx="21" fill="#252b41" stroke="#3e4771" stroke-width="1"/>
  <circle cx="95" cy="633" r="6" fill="#8490ff"/>
  <text x="112" y="639" fill="#b6beff" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="1">AVATAR CHANGE</text>

  <text x="410" y="83" fill="#9da7d2" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">PROFILE PICTURE</text>
  <text x="580" y="180" text-anchor="middle" fill="#aeb3c7" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="700" letter-spacing="2">BEFORE</text>
  <text x="970" y="180" text-anchor="middle" fill="#8792ff" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="700" letter-spacing="2">AFTER</text>
  ${avatarMarkup(beforeAvatar, 464, 239, 232, "before-avatar-clip", 580, 355, 116, "OLD")}
  <circle cx="580" cy="355" r="120" fill="none" stroke="#c0c5d7" stroke-width="5"/>
  ${avatarMarkup(afterAvatar, 854, 239, 232, "after-avatar-clip", 970, 355, 116, "NEW")}
  <circle cx="970" cy="355" r="120" fill="none" stroke="#8792ff" stroke-width="5"/>
  <path d="M748 355 H802 M787 340 L803 355 L787 370" fill="none" stroke="#8792ff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="580" y="535" text-anchor="middle" fill="#9ba4c2" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1">OLD AVATAR</text>
  <text x="970" y="535" text-anchor="middle" fill="#9ba4c2" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1">CURRENT AVATAR</text>
  <line x1="440" y1="585" x2="1110" y2="585" stroke="#343a50" stroke-width="2"/>
  <text x="440" y="630" fill="#b4bbd1" font-family="DejaVu Sans, sans-serif" font-size="19">${escapeXml(shortLine(options.authorName, 32))}</text>
  <text x="440" y="662" fill="#8891ab" font-family="DejaVu Sans, sans-serif" font-size="16">ID: ${escapeXml(options.authorId)}</text>`;
  return svgShell(definitions, body);
}

export function createMessageDeleteCardSvg(
  options: MessageDeleteCardOptions,
  profileAvatar?: string,
): string {
  const content = wrapText(options.content, 9, 50);
  const notice = content.truncated
    ? '<text x="445" y="635" fill="#9ba4c2" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1">MESSAGE PREVIEW SHORTENED TO FIT</text>'
    : "";
  const definitions =
    '<clipPath id="profile-avatar-clip"><circle cx="172" cy="214" r="81"/></clipPath>';
  const body = `${profileMarkup(options, profileAvatar)}
  <rect x="72" y="612" width="210" height="42" rx="21" fill="#252b41" stroke="#3e4771" stroke-width="1"/>
  <circle cx="95" cy="633" r="6" fill="#8490ff"/>
  <text x="112" y="639" fill="#b6beff" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="1">MESSAGE DELETE</text>

  <text x="410" y="83" fill="#9da7d2" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">DELETED MESSAGE</text>
  <text x="410" y="137" fill="#8792ff" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="700" letter-spacing="2">CONTENT</text>
  <rect x="410" y="158" width="730" height="452" rx="20" fill="url(#panel)" stroke="#414a74" stroke-width="2"/>
  <rect x="410" y="158" width="6" height="452" rx="3" fill="#8792ff"/>
  <text fill="#f1f2fb" font-family="DejaVu Sans, sans-serif" font-size="22" xml:space="preserve">${lineMarkup(content.lines, 444, 210, 34)}</text>
  ${notice}
  <text x="410" y="686" fill="#8991aa" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1">MESSAGE REMOVED FROM THE CHANNEL</text>`;
  return svgShell(definitions, body);
}

export async function renderNameChangeCard(
  options: NameChangeCardOptions,
): Promise<Buffer> {
  const avatar = await loadAvatarDataUrl(options.avatarUrl).catch(() => undefined);
  return renderSvgToPng(createNameChangeCardSvg(options, avatar));
}

export async function renderAvatarChangeCard(
  options: AvatarChangeCardOptions,
): Promise<Buffer> {
  const [beforeAvatar, afterAvatar] = await Promise.all([
    loadAvatarDataUrl(options.beforeAvatarUrl).catch(() => undefined),
    loadAvatarDataUrl(options.afterAvatarUrl).catch(() => undefined),
  ]);
  return renderSvgToPng(
    createAvatarChangeCardSvg(
      options,
      afterAvatar ?? (await loadAvatarDataUrl(options.avatarUrl).catch(() => undefined)),
      beforeAvatar,
      afterAvatar,
    ),
  );
}

export async function renderMessageDeleteCard(
  options: MessageDeleteCardOptions,
): Promise<Buffer> {
  const avatar = await loadAvatarDataUrl(options.avatarUrl).catch(() => undefined);
  return renderSvgToPng(createMessageDeleteCardSvg(options, avatar));
}
