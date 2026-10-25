import { createHmac, randomBytes } from "node:crypto";

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const CAPTCHA_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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
  missingSettings: string[];
  guildConfig: VerificationGuildConfig | null;
  captchaRendering: {
    supported: boolean;
    provider: string;
    note: string;
  };
}

export class VerificationApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super("Verification is temporarily unavailable.");
    this.name = "VerificationApiError";
  }
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
    let errorCode: string | undefined;
    let retryAfterSeconds: number | undefined;
    try {
      const error = (await response.json()) as {
        errorCode?: unknown;
        retryAfterSeconds?: unknown;
      };
      if (typeof error.errorCode === "string") errorCode = error.errorCode;
      if (typeof error.retryAfterSeconds === "number") {
        retryAfterSeconds = error.retryAfterSeconds;
      }
    } catch {
      // Keep errors generic if the API did not return JSON.
    }
    throw new VerificationApiError(
      response.status,
      errorCode,
      retryAfterSeconds,
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("Verification is temporarily unavailable.");
  }
}
