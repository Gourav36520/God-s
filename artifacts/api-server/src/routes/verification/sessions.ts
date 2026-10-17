import { Router } from "express";
import {
  configOrNull,
  hasExactKeys,
  verificationDatabase,
} from "../../lib/verification/http";
import { createOpaqueToken, hashSecret, safeEqual, VERIFICATION_SESSION_TTL_MS } from "../../lib/verification/core";
import { signBotRequest } from "../../lib/verification/crypto";
import { allowRateLimitedAttempt } from "../../lib/verification/rateLimit";

const router = Router();
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const BOT_NONCE_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

router.post("/verification/sessions", async (req, res): Promise<void> => {
  const config = configOrNull();
  if (!config) {
    res.status(503).json({ error: "Verification is temporarily unavailable." });
    return;
  }

  if (
    !hasExactKeys(req.body, ["userId", "guildId"]) ||
    typeof req.body.userId !== "string" ||
    typeof req.body.guildId !== "string" ||
    !SNOWFLAKE_PATTERN.test(req.body.userId) ||
    !SNOWFLAKE_PATTERN.test(req.body.guildId)
  ) {
    res.status(400).json({ error: "Invalid verification request." });
    return;
  }

  const userId = req.body.userId;
  const guildId = req.body.guildId;
  const timestampText = req.header("x-verification-timestamp") ?? "";
  const nonce = req.header("x-verification-nonce") ?? "";
  const suppliedSignature = req.header("x-verification-signature") ?? "";
  const timestamp = Number(timestampText);
  const now = new Date();

  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now.getTime() - timestamp) > 5 * 60 * 1000 ||
    !BOT_NONCE_PATTERN.test(nonce) ||
    !/^[a-f0-9]{64}$/i.test(suppliedSignature)
  ) {
    res.status(401).json({ error: "Invalid verification request." });
    return;
  }

  const expectedSignature = signBotRequest(
    timestampText,
    nonce,
    userId,
    guildId,
    config.botHmacSecret,
  );
  if (!safeEqual(expectedSignature, suppliedSignature.toLowerCase())) {
    res.status(401).json({ error: "Invalid verification request." });
    return;
  }

  if (!allowRateLimitedAttempt(`create:${guildId}:${userId}`, 3, 10 * 60 * 1000)) {
    res.status(429).json({ error: "Please wait before requesting another link." });
    return;
  }

  try {
    const {
      db,
      verificationBotNoncesTable,
      verificationSessionsTable,
    } = await verificationDatabase();
    const nonceHash = hashSecret(nonce);
    const [acceptedNonce] = await db
      .insert(verificationBotNoncesTable)
      .values({
        nonceHash,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      })
      .onConflictDoNothing()
      .returning({ nonceHash: verificationBotNoncesTable.nonceHash });

    if (!acceptedNonce) {
      res.status(401).json({ error: "Invalid verification request." });
      return;
    }

    const sessionId = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + VERIFICATION_SESSION_TTL_MS);
    await db.insert(verificationSessionsTable).values({
      sessionHash: hashSecret(sessionId),
      userId,
      guildId,
      status: "pending",
      expiresAt,
    });

    const verificationUrl = new URL("/api/verify", config.publicBaseUrl);
    verificationUrl.searchParams.set("session", sessionId);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      verificationUrl: verificationUrl.toString(),
      expiresAt: expiresAt.toISOString(),
    });
  } catch {
    req.log.error("Could not create a verification session");
    res.status(503).json({ error: "Verification is temporarily unavailable." });
  }
});

export default router;
