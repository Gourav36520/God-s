import { createHmac, randomBytes } from "node:crypto";

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const VERIFICATION_BUTTON_ID = "verification:start";

export interface VerificationGuildConfig {
  guildId: string;
  channelId: string;
  verifiedRoleId: string;
  enabled: boolean;
}

export interface VerificationDiagnostics {
  hmacAuthenticated: boolean;
  databaseConnected: boolean;
  verificationSchemaReady: boolean;
  verificationConfigured: boolean;
  botTokenConfigured: boolean;
  missingSettings: string[];
  guildConfig: VerificationGuildConfig | null;
  captchaRendering: {
    supported: boolean;
    provider: string;
    note: string;
  };
}

function requiredHttpsUrl(value: string | undefined): URL {
  if (!value) throw new Error("Verification is not configured.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Verification is not configured.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Verification is not configured.");
  }
  return url;
}

export async function checkVerificationApiHealth(): Promise<boolean> {
  try {
    const apiBase = requiredHttpsUrl(process.env.VERIFICATION_API_BASE_URL);
    const response = await fetch(new URL("/api/healthz", apiBase), {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function verificationAdminRequest<T>(
  userId: string,
  guildId: string,
  action: string,
  fields: Record<string, string> = {},
): Promise<T> {
  if (!SNOWFLAKE_PATTERN.test(userId) || !SNOWFLAKE_PATTERN.test(guildId)) {
    throw new Error("Invalid Discord interaction.");
  }
  const apiBase = requiredHttpsUrl(process.env.VERIFICATION_API_BASE_URL);
  const secret = process.env.VERIFICATION_BOT_HMAC_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Verification is not configured.");
  }

  const timestamp = Date.now().toString();
  const nonce = randomBytes(24).toString("base64url");
  const body = JSON.stringify({ userId, guildId, action, ...fields });
  const signature = createHmac("sha256", secret)
    .update(`POST /api/verification/admin\n${timestamp}\n${nonce}\n${body}`)
    .digest("hex");
  const response = await fetch(new URL("/api/verification/admin", apiBase), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-verification-timestamp": timestamp,
      "x-verification-nonce": nonce,
      "x-verification-signature": signature,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error("Verification is temporarily unavailable.");
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("Verification is temporarily unavailable.");
  }
}

export async function createVerificationLink(
  userId: string,
  guildId: string,
): Promise<string> {
  if (!SNOWFLAKE_PATTERN.test(userId) || !SNOWFLAKE_PATTERN.test(guildId)) {
    throw new Error("Invalid Discord interaction.");
  }

  const apiBase = requiredHttpsUrl(process.env.VERIFICATION_API_BASE_URL);
  const publicBase = requiredHttpsUrl(process.env.VERIFICATION_PUBLIC_BASE_URL);
  const secret = process.env.VERIFICATION_BOT_HMAC_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Verification is not configured.");
  }

  const timestamp = Date.now().toString();
  const nonce = randomBytes(24).toString("base64url");
  const body = JSON.stringify({ userId, guildId });
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}\n${nonce}\n${userId}\n${guildId}`)
    .digest("hex");

  const endpoint = new URL("/api/verification/sessions", apiBase);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-verification-timestamp": timestamp,
      "x-verification-nonce": nonce,
      "x-verification-signature": signature,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error("Verification is temporarily unavailable.");
  }

  const result = (await response.json()) as {
    verificationUrl?: unknown;
  };
  if (typeof result.verificationUrl !== "string") {
    throw new Error("Verification is temporarily unavailable.");
  }

  const verificationUrl = new URL(result.verificationUrl);
  const session = verificationUrl.searchParams.get("session");
  if (
    verificationUrl.protocol !== "https:" ||
    verificationUrl.origin !== publicBase.origin ||
    verificationUrl.pathname !== "/api/verify" ||
    verificationUrl.searchParams.size !== 1 ||
    verificationUrl.hash ||
    verificationUrl.username ||
    verificationUrl.password ||
    !session ||
    !SESSION_PATTERN.test(session)
  ) {
    throw new Error("Verification is temporarily unavailable.");
  }
  return verificationUrl.toString();
}
