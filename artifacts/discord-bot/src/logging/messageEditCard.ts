import { spawn } from "node:child_process";

export interface MessageEditCardOptions {
  authorName: string;
  authorTag: string;
  authorId: string;
  avatarUrl?: string;
  beforeContent: string;
  afterContent: string;
}

const CARD_WIDTH = 1_200;
const CARD_HEIGHT = 760;
const MAX_INPUT_CHARS = 12_000;
const MAX_LINE_CHARS = 54;
const MAX_CONTENT_LINES = 5;
const MAX_AVATAR_BYTES = 1_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function escapeXml(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0 ||
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      sanitized += "�";
    } else {
      sanitized += character;
    }
  }

  return sanitized
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function characterUnits(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x1100 ? 2 : 1;
}

function textUnits(value: string): number {
  return Array.from(value).reduce(
    (total, character) => total + characterUnits(character),
    0,
  );
}

function takeUnits(value: string, maxUnits: number): { head: string; tail: string } {
  const characters = Array.from(value);
  let units = 0;
  let index = 0;
  while (
    index < characters.length &&
    units + characterUnits(characters[index]) <= maxUnits
  ) {
    units += characterUnits(characters[index]);
    index += 1;
  }
  return {
    head: characters.slice(0, index).join(""),
    tail: characters.slice(index).join(""),
  };
}

function wrapContent(value: string): { lines: string[]; truncated: boolean } {
  const limitedInput = value
    .slice(0, MAX_INPUT_CHARS)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ");
  const lines: string[] = [];

  for (const paragraph of limitedInput.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      let remaining = word;
      while (textUnits(remaining) > MAX_LINE_CHARS) {
        const chunk = takeUnits(remaining, MAX_LINE_CHARS);
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(chunk.head);
        remaining = chunk.tail;
      }

      if (!remaining) continue;
      if (
        line &&
        textUnits(line) + textUnits(remaining) + 1 > MAX_LINE_CHARS
      ) {
        lines.push(line);
        line = remaining;
      } else {
        line = line ? `${line} ${remaining}` : remaining;
      }
    }
    if (line) lines.push(line);
  }

  const truncated = lines.length > MAX_CONTENT_LINES || value.length > MAX_INPUT_CHARS;
  const visibleLines = lines.slice(0, MAX_CONTENT_LINES);
  if (truncated) {
    const lastLine = visibleLines[MAX_CONTENT_LINES - 1] ?? "";
    const shortened = takeUnits(lastLine, MAX_LINE_CHARS - 1);
    visibleLines[MAX_CONTENT_LINES - 1] = `${shortened.head}…`;
  }

  return {
    lines: visibleLines.length ? visibleLines : ["(empty)"],
    truncated,
  };
}

function renderTextLines(lines: string[], x: number, y: number): string {
  return lines
    .map(
      (line, index) =>
        `<tspan x="${x}" y="${y + index * 29}">${escapeXml(line)}</tspan>`,
    )
    .join("");
}

function shortenSingleLine(value: string, maxUnits: number): string {
  const shortened = takeUnits(value, maxUnits);
  return shortened.tail ? `${takeUnits(value, maxUnits - 1).head}…` : value;
}

function initials(name: string): string {
  const value = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join()
    .replace(/,/g, "")
    .toUpperCase();
  return value || "?";
}

function safeAvatarDataUrl(dataUrl?: string): string | null {
  if (
    !dataUrl ||
    !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)
  ) {
    return null;
  }
  return dataUrl;
}

export function createMessageEditCardSvg(
  options: MessageEditCardOptions,
  avatarDataUrl?: string,
): string {
  const before = wrapContent(options.beforeContent);
  const after = wrapContent(options.afterContent);
  const safeAvatar = safeAvatarDataUrl(avatarDataUrl);
  const avatarMarkup = safeAvatar
    ? `<image x="84" y="117" width="176" height="176" href="${safeAvatar}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)"/>`
    : `<circle cx="172" cy="205" r="86" fill="#24283a"/><text x="172" y="219" text-anchor="middle" fill="#aeb8ff" font-family="DejaVu Sans, sans-serif" font-size="42" font-weight="700">${escapeXml(initials(options.authorName))}</text>`;
  const notice = [
    before.truncated ? "BEFORE CONTENT SHORTENED" : "",
    after.truncated ? "AFTER CONTENT SHORTENED" : "",
  ]
    .filter(Boolean)
    .join("  •  ");
  const contentNotice = notice
    ? `<text x="410" y="700" fill="#9ba4c2" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="1">${escapeXml(notice)}</text>`
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
    <clipPath id="avatar-clip"><circle cx="172" cy="205" r="83"/></clipPath>
  </defs>
  <rect width="1200" height="760" rx="30" fill="url(#background)"/>
  <path d="M25 220 L220 25 M95 300 L370 25 M855 25 L1165 335 M1015 25 L1175 185" fill="none" stroke="#5865f2" stroke-opacity=".045" stroke-width="34"/>
  <rect x="20" y="20" width="1160" height="720" rx="28" fill="none" stroke="#7784ff" stroke-width="5"/>
  <line x1="356" y1="70" x2="356" y2="690" stroke="#353b52" stroke-width="2"/>

  <text x="72" y="82" fill="#9da7d2" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">AUTHOR</text>
  ${avatarMarkup}
  <circle cx="172" cy="205" r="86" fill="none" stroke="#8490ff" stroke-width="5"/>
  <text x="72" y="354" fill="#f5f6ff" font-family="DejaVu Sans, sans-serif" font-size="30" font-weight="700">${escapeXml(shortenSingleLine(options.authorName, 16))}</text>
  <text x="72" y="396" fill="#adb3c7" font-family="DejaVu Sans, sans-serif" font-size="21">${escapeXml(shortenSingleLine(options.authorTag, 22))}</text>
  <text x="72" y="440" fill="#8991aa" font-family="DejaVu Sans, sans-serif" font-size="17">ID: ${escapeXml(options.authorId)}</text>
  <rect x="72" y="612" width="210" height="42" rx="21" fill="#252b41" stroke="#3e4771" stroke-width="1"/>
  <circle cx="95" cy="633" r="6" fill="#8490ff"/>
  <text x="112" y="639" fill="#b6beff" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="1">MESSAGE EDIT</text>

  <text x="410" y="83" fill="#9da7d2" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="2">CONTENT COMPARISON</text>
  <text x="410" y="137" fill="#aeb3c7" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="700" letter-spacing="2">BEFORE</text>
  <rect x="410" y="158" width="730" height="194" rx="20" fill="url(#panel)" stroke="#343a50" stroke-width="2"/>
  <rect x="410" y="158" width="6" height="194" rx="3" fill="#6d78e8"/>
  <text fill="#f1f2fb" font-family="DejaVu Sans, sans-serif" font-size="22" xml:space="preserve">${renderTextLines(before.lines, 444, 204)}</text>

  <path d="M775 383 V420 M758 403 L775 420 L792 403" fill="none" stroke="#8792ff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>

  <text x="410" y="461" fill="#8792ff" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="700" letter-spacing="2">AFTER</text>
  <rect x="410" y="482" width="730" height="194" rx="20" fill="url(#panel)" stroke="#414a74" stroke-width="2"/>
  <rect x="410" y="482" width="6" height="194" rx="3" fill="#8792ff"/>
  <text fill="#f1f2fb" font-family="DejaVu Sans, sans-serif" font-size="22" xml:space="preserve">${renderTextLines(after.lines, 444, 528)}</text>
  ${contentNotice}
</svg>`;
}

async function fetchAvatarDataUrl(avatarUrl?: string): Promise<string | undefined> {
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
  if (image.length === 0 || image.length > MAX_AVATAR_BYTES) return undefined;

  return `data:${contentType};base64,${image.toString("base64")}`;
}

function convertSvgToPng(svg: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const renderer = spawn("magick", ["svg:-", "png:-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputSize = 0;
    let errorSize = 0;
    let settled = false;

    const finish = (error?: Error, png?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else if (png) resolve(png);
      else reject(new Error("Message edit card renderer returned no image"));
    };

    const timeout = setTimeout(() => {
      renderer.kill("SIGKILL");
      finish(new Error("Message edit card rendering timed out"));
    }, 8_000);

    renderer.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 2_000_000) {
        renderer.kill("SIGKILL");
        finish(new Error("Message edit card image exceeded the size limit"));
      } else {
        output.push(chunk);
      }
    });
    renderer.stderr.on("data", (chunk: Buffer) => {
      if (errorSize >= 4_000) return;
      const remaining = 4_000 - errorSize;
      const kept = chunk.subarray(0, remaining);
      errors.push(kept);
      errorSize += kept.length;
    });
    renderer.once("error", (error) => finish(error));
    renderer.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            `Message edit card renderer exited with code ${code}: ${Buffer.concat(errors).toString("utf8")}`,
          ),
        );
        return;
      }

      const png = Buffer.concat(output);
      if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        finish(new Error("Message edit card renderer did not return a PNG"));
        return;
      }
      finish(undefined, png);
    });
    renderer.stdin.on("error", () => {});
    renderer.stdin.end(svg);
  });
}

export async function renderMessageEditCard(
  options: MessageEditCardOptions,
): Promise<Buffer> {
  const avatarDataUrl = await fetchAvatarDataUrl(options.avatarUrl).catch(
    () => undefined,
  );
  return convertSvgToPng(createMessageEditCardSvg(options, avatarDataUrl));
}
