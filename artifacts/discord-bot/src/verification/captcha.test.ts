import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import {
  CAPTCHA_ALPHABET,
  checkCaptchaGlyphRendering,
  generateCaptchaCode,
  hashCaptchaAnswer,
  renderCaptchaPng,
} from "./captcha.js";

test("every supported CAPTCHA character has a renderable bitmap glyph", () => {
  assert.equal(checkCaptchaGlyphRendering(), true);
  assert.equal(new Set(CAPTCHA_ALPHABET).size, CAPTCHA_ALPHABET.length);
  for (const character of CAPTCHA_ALPHABET) {
    const png = renderCaptchaPng(character.repeat(6));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const imageChunks: Buffer[] = [];
    let offset = 8;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const kind = png.toString("ascii", offset + 4, offset + 8);
      if (kind === "IDAT") {
        imageChunks.push(png.subarray(offset + 8, offset + 8 + length));
      }
      offset += length + 12;
      if (kind === "IEND") break;
    }
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.equal(
      inflateSync(Buffer.concat(imageChunks)).length,
      (width * 4 + 1) * height,
    );
  }
});

test("CAPTCHA codes use only supported characters and answer hashes are keyed", () => {
  const code = generateCaptchaCode();
  assert.equal(code.length, 6);
  assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  const secret = "test-only-secret-material-long-enough";
  assert.equal(
    hashCaptchaAnswer("a".repeat(32), "abcd23", secret),
    hashCaptchaAnswer("a".repeat(32), "ABCD23", secret),
  );
  assert.notEqual(
    hashCaptchaAnswer("a".repeat(32), "ABCD23", secret),
    hashCaptchaAnswer("b".repeat(32), "ABCD23", secret),
  );
});

test("CAPTCHA renderer rejects unsupported characters and lengths", () => {
  assert.throws(() => renderCaptchaPng("O0I1AB"));
  assert.throws(() => renderCaptchaPng("ABCDE"));
});
