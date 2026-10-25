import { createHmac, randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

export const CAPTCHA_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CAPTCHA_CODE_LENGTH = 6;

const FONT: Record<string, readonly string[]> = {
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

const SCALE = 4;
const PADDING = 12;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_GAP = 2;
const CELL_WIDTH = (GLYPH_WIDTH + GLYPH_GAP) * SCALE;
const IMAGE_WIDTH =
  PADDING * 2 +
  CAPTCHA_CODE_LENGTH * CELL_WIDTH -
  GLYPH_GAP * SCALE;
const IMAGE_HEIGHT = PADDING * 2 + GLYPH_HEIGHT * SCALE;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function setPixel(
  pixels: Buffer,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  if (x < 0 || y < 0 || x >= IMAGE_WIDTH || y >= IMAGE_HEIGHT) return;
  const offset = y * (IMAGE_WIDTH * 4 + 1) + 1 + x * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

function fillRect(
  pixels: Buffer,
  x: number,
  y: number,
  width: number,
  height: number,
  color: readonly [number, number, number, number],
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setPixel(pixels, column, row, color);
    }
  }
}

function drawLine(
  pixels: Buffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly [number, number, number, number],
): void {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;

  while (true) {
    fillRect(pixels, x0, y0, 2, 2, color);
    if (x0 === x1 && y0 === y1) break;
    const twiceError = 2 * error;
    if (twiceError >= dy) {
      error += dy;
      x0 += sx;
    }
    if (twiceError <= dx) {
      error += dx;
      y0 += sy;
    }
  }
}

export function generateCaptchaCode(): string {
  return Array.from({ length: CAPTCHA_CODE_LENGTH }, () =>
    CAPTCHA_ALPHABET[randomInt(CAPTCHA_ALPHABET.length)],
  ).join("");
}

export function hashCaptchaAnswer(
  salt: string,
  answer: string,
  secret: string,
): string {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Verification is not configured.");
  }
  return createHmac("sha256", secret)
    .update(`captcha:${salt}:${answer.trim().toUpperCase()}`, "utf8")
    .digest("hex");
}

export function renderCaptchaPng(value: string): Buffer {
  const code = value.toUpperCase();
  if (
    code.length !== CAPTCHA_CODE_LENGTH ||
    [...code].some((character) => !CAPTCHA_ALPHABET.includes(character))
  ) {
    throw new Error("Unsupported CAPTCHA text.");
  }
  for (const character of code) {
    const glyph = FONT[character];
    if (
      !glyph ||
      glyph.length !== GLYPH_HEIGHT ||
      glyph.some((row) => row.length !== GLYPH_WIDTH || /[^01]/.test(row))
    ) {
      throw new Error("CAPTCHA font is missing a character glyph.");
    }
  }

  const stride = IMAGE_WIDTH * 4 + 1;
  const pixels = Buffer.alloc(stride * IMAGE_HEIGHT);
  for (let y = 0; y < IMAGE_HEIGHT; y += 1) {
    const rowStart = y * stride;
    pixels[rowStart] = 0;
    for (let x = 0; x < IMAGE_WIDTH; x += 1) {
      const offset = rowStart + 1 + x * 4;
      pixels[offset] = 248;
      pixels[offset + 1] = 250;
      pixels[offset + 2] = 253;
      pixels[offset + 3] = 255;
    }
  }

  const noiseColors = [
    [216, 225, 239, 255],
    [233, 215, 220, 255],
  ] as const;
  for (let line = 0; line < 3; line += 1) {
    drawLine(
      pixels,
      randomInt(IMAGE_WIDTH),
      randomInt(IMAGE_HEIGHT),
      randomInt(IMAGE_WIDTH),
      randomInt(IMAGE_HEIGHT),
      noiseColors[line % noiseColors.length]!,
    );
  }

  code.split("").forEach((character, index) => {
    const glyph = FONT[character]!;
    const xOffset = PADDING + index * CELL_WIDTH;
    const yOffset = PADDING + randomInt(3) - 1;
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        if (glyph[row]![column] === "1") {
          fillRect(
            pixels,
            xOffset + column * SCALE,
            yOffset + row * SCALE,
            SCALE,
            SCALE,
            [34, 48, 72, 255],
          );
        }
      }
    }
  });

  const header = Buffer.alloc(13);
  header.writeUInt32BE(IMAGE_WIDTH, 0);
  header.writeUInt32BE(IMAGE_HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function checkCaptchaGlyphRendering(): boolean {
  return [...CAPTCHA_ALPHABET].every((character) => {
    try {
      const image = renderCaptchaPng(character.repeat(CAPTCHA_CODE_LENGTH));
      return image.subarray(0, 8).equals(PNG_SIGNATURE);
    } catch {
      return false;
    }
  });
}
