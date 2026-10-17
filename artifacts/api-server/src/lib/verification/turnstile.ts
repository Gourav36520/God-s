import { randomUUID } from "node:crypto";
import {
  validateTurnstileAssessment,
  type TurnstileAssessment,
} from "./core";

interface TurnstileSiteverifyResponse extends TurnstileAssessment {
  "error-codes"?: string[];
}

export async function verifyTurnstileToken(
  token: string,
  secret: string,
  expectedHostname: string,
  now = new Date(),
): Promise<boolean> {
  if (!token || token.length > 2048) return false;

  const body = new URLSearchParams({
    secret,
    response: token,
    idempotency_key: randomUUID(),
  });
  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  let assessment: TurnstileSiteverifyResponse;
  try {
    assessment = (await response.json()) as TurnstileSiteverifyResponse;
  } catch {
    return false;
  }

  return validateTurnstileAssessment(
    assessment,
    expectedHostname,
    "verify",
    now,
  );
}
