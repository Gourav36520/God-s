import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

export function signBotRequest(
  timestamp: string,
  nonce: string,
  userId: string,
  guildId: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${nonce}\n${userId}\n${guildId}`)
    .digest("hex");
}

export function encryptEmail(email: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(email, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptEmail(value: string, key: Buffer): string {
  const [version, ivText, tagText, ciphertextText] = value.split(":");
  if (
    version !== "v1" ||
    !ivText ||
    !tagText ||
    ciphertextText === undefined
  ) {
    throw new Error("Invalid encrypted email value.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function signPrivateLog(
  timestamp: string,
  eventId: string,
  body: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${eventId}\n${body}`)
    .digest("hex");
}
