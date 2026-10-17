import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const VERIFICATION_SESSION_TTL_MS = 15 * 60 * 1000;
export const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
export const TURNSTILE_MAX_AGE_MS = 5 * 60 * 1000;
export const TURNSTILE_CLOCK_SKEW_MS = 30 * 1000;

export interface TurnstileAssessment {
  success?: boolean;
  hostname?: string;
  action?: string;
  challenge_ts?: string;
}

export interface OAuthStateRecord {
  stateHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function isExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function validateOAuthState(
  record: OAuthStateRecord,
  suppliedState: string,
  cookieState: string | undefined,
  now = new Date(),
): boolean {
  if (record.consumedAt || isExpired(record.expiresAt, now)) return false;
  if (!cookieState || !safeEqual(suppliedState, cookieState)) return false;
  return safeEqual(hashSecret(suppliedState), record.stateHash);
}

export function assertOAuthIdentity(
  expectedUserId: string,
  returnedUserId: string,
): void {
  if (!expectedUserId || !returnedUserId || expectedUserId !== returnedUserId) {
    throw new Error("OAUTH_ACCOUNT_MISMATCH");
  }
}

export function validateTurnstileAssessment(
  assessment: TurnstileAssessment,
  expectedHostname: string,
  expectedAction: string,
  now = new Date(),
): boolean {
  if (
    assessment.success !== true ||
    assessment.hostname?.toLowerCase() !== expectedHostname.toLowerCase() ||
    assessment.action !== expectedAction ||
    typeof assessment.challenge_ts !== "string"
  ) {
    return false;
  }

  const challengeTime = Date.parse(assessment.challenge_ts);
  if (!Number.isFinite(challengeTime)) return false;
  const age = now.getTime() - challengeTime;
  return age >= -TURNSTILE_CLOCK_SKEW_MS && age <= TURNSTILE_MAX_AGE_MS;
}

export function optionalEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}
