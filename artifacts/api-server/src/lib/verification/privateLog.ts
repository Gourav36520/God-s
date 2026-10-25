import { signPrivateLog } from "./crypto";

export interface PrivateVerificationEvent {
  eventId: string;
  discordUserId: string;
  guildId: string;
  usernameSnapshot: string;
  verificationTimestamp: string;
  result: "verified";
  email: string | null;
  cloudflareRayId: null;
  retentionDays: number;
}

export async function sendPrivateVerificationEvent(
  url: URL,
  secret: string,
  event: PrivateVerificationEvent,
): Promise<boolean> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPrivateLog(timestamp, event.eventId, body, secret);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-verification-timestamp": timestamp,
        "x-verification-event-id": event.eventId,
        "x-verification-signature": signature,
        "idempotency-key": event.eventId,
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
