export interface VerificationConfig {
  publicBaseUrl: URL;
  expectedHostname: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthCallbackUrl: string;
  turnstileSiteKey: string;
  turnstileSecretKey: string;
  botHmacSecret: string;
  privateLogUrl: URL;
  privateLogHmacSecret: string;
  emailEncryptionKey: Buffer;
  retentionDays: number;
}

export class VerificationConfigurationError extends Error {
  constructor() {
    super("Verification is not configured.");
    this.name = "VerificationConfigurationError";
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new VerificationConfigurationError();
  return value;
}

function httpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VerificationConfigurationError();
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new VerificationConfigurationError();
  }
  return url;
}

function hmacSecret(env: NodeJS.ProcessEnv, key: string): string {
  const secret = required(env, key);
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new VerificationConfigurationError();
  }
  return secret;
}

export function getVerificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): VerificationConfig {
  const publicBaseUrl = httpsUrl(required(env, "VERIFICATION_PUBLIC_BASE_URL"));
  if (
    publicBaseUrl.pathname !== "/" ||
    publicBaseUrl.search ||
    publicBaseUrl.hash
  ) {
    throw new VerificationConfigurationError();
  }
  const expectedHostname = required(
    env,
    "VERIFICATION_EXPECTED_HOSTNAME",
  ).toLowerCase();
  if (publicBaseUrl.hostname.toLowerCase() !== expectedHostname) {
    throw new VerificationConfigurationError();
  }

  const callbackUrl = httpsUrl(required(env, "DISCORD_OAUTH_CALLBACK_URL"));
  if (
    callbackUrl.origin !== publicBaseUrl.origin ||
    callbackUrl.pathname !== "/api/verification/callback" ||
    callbackUrl.search ||
    callbackUrl.hash
  ) {
    throw new VerificationConfigurationError();
  }

  const privateLogUrl = httpsUrl(required(env, "VERIFICATION_PRIVATE_LOG_URL"));
  if (
    privateLogUrl.origin === publicBaseUrl.origin ||
    privateLogUrl.search ||
    privateLogUrl.hash
  ) {
    throw new VerificationConfigurationError();
  }

  const retentionDays = Number(required(env, "VERIFICATION_RETENTION_DAYS"));
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new VerificationConfigurationError();
  }

  const encryptionKey = Buffer.from(
    required(env, "VERIFICATION_DATA_ENCRYPTION_KEY"),
    "base64",
  );
  if (encryptionKey.length !== 32) {
    throw new VerificationConfigurationError();
  }

  return {
    publicBaseUrl,
    expectedHostname,
    oauthClientId:
      env.DISCORD_OAUTH_CLIENT_ID?.trim() ||
      required(env, "CLIENT_ID"),
    oauthClientSecret: required(env, "DISCORD_OAUTH_CLIENT_SECRET"),
    oauthCallbackUrl: callbackUrl.toString(),
    turnstileSiteKey: required(env, "CLOUDFLARE_TURNSTILE_SITE_KEY"),
    turnstileSecretKey: required(env, "CLOUDFLARE_TURNSTILE_SECRET_KEY"),
    botHmacSecret: hmacSecret(env, "VERIFICATION_BOT_HMAC_SECRET"),
    privateLogUrl,
    privateLogHmacSecret: hmacSecret(env, "VERIFICATION_LOG_HMAC_SECRET"),
    emailEncryptionKey: encryptionKey,
    retentionDays,
  };
}

export function getMissingVerificationSettings(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const requiredKeys = [
    "VERIFICATION_PUBLIC_BASE_URL",
    "VERIFICATION_EXPECTED_HOSTNAME",
    "DISCORD_OAUTH_CALLBACK_URL",
    "DISCORD_OAUTH_CLIENT_SECRET",
    "CLOUDFLARE_TURNSTILE_SITE_KEY",
    "CLOUDFLARE_TURNSTILE_SECRET_KEY",
    "VERIFICATION_BOT_HMAC_SECRET",
    "VERIFICATION_PRIVATE_LOG_URL",
    "VERIFICATION_LOG_HMAC_SECRET",
    "VERIFICATION_DATA_ENCRYPTION_KEY",
    "VERIFICATION_RETENTION_DAYS",
  ];
  const missing = requiredKeys.filter((key) => !env[key]?.trim());

  if (!env.DISCORD_OAUTH_CLIENT_ID?.trim() && !env.CLIENT_ID?.trim()) {
    missing.push("DISCORD_OAUTH_CLIENT_ID or CLIENT_ID");
  }

  for (const key of [
    "VERIFICATION_BOT_HMAC_SECRET",
    "VERIFICATION_LOG_HMAC_SECRET",
  ]) {
    const value = env[key]?.trim();
    if (value && Buffer.byteLength(value, "utf8") < 32 && !missing.includes(key)) {
      missing.push(key);
    }
  }

  const retentionDays = Number(env.VERIFICATION_RETENTION_DAYS);
  if (
    env.VERIFICATION_RETENTION_DAYS?.trim() &&
    (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
  ) {
    missing.push("VERIFICATION_RETENTION_DAYS");
  }

  const encryptionKey = env.VERIFICATION_DATA_ENCRYPTION_KEY?.trim();
  if (
    encryptionKey &&
    Buffer.from(encryptionKey, "base64").length !== 32
  ) {
    missing.push("VERIFICATION_DATA_ENCRYPTION_KEY");
  }

  try {
    getVerificationConfig(env);
  } catch {
    if (missing.length === 0) {
      missing.push("Verification configuration values");
    }
  }

  return [...new Set(missing)];
}
