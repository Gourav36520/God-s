import { and, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { Router } from "express";
import { getMissingVerificationSettings } from "../../lib/verification/config";
import { signBotAdminRequest } from "../../lib/verification/crypto";
import {
  createOpaqueToken,
  hashSecret,
  safeEqual,
} from "../../lib/verification/core";
import { allowRateLimitedAttempt } from "../../lib/verification/rateLimit";

const router = Router();
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;
const CAPTCHA_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CAPTCHA_SALT_PATTERN = /^[a-f0-9]{32}$/;
const CAPTCHA_HASH_PATTERN = /^[a-f0-9]{64}$/;
const CAPTCHA_ANSWER_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;
const CAPTCHA_TTL_MS = 3 * 60 * 1000;
const CAPTCHA_MAX_ATTEMPTS = 5;
const CAPTCHA_COOLDOWN_MS = 60 * 1000;
const MUTATING_ACTIONS = new Set([
  "config:set",
  "config:reset",
  "sessions:reset",
  "challenge:create",
  "challenge:verify",
  "challenge:complete",
  "challenge:fail",
]);

function hasActionShape(
  body: Record<string, unknown>,
): body is Record<string, string> {
  const action = body.action;
  let keys: string[];
  switch (action) {
    case "diagnostics":
    case "config:get":
    case "config:reset":
    case "stats":
      keys = ["userId", "guildId", "action"];
      break;
    case "config:set":
      keys = ["userId", "guildId", "action", "channelId", "verifiedRoleId"];
      break;
    case "sessions:reset":
      keys = ["userId", "guildId", "action"];
      break;
    case "challenge:create":
      keys = [
        "userId",
        "guildId",
        "action",
        "channelId",
        "answerHash",
        "salt",
      ];
      break;
    case "challenge:verify":
      keys = ["userId", "guildId", "action", "challengeId", "answer"];
      break;
    case "challenge:complete":
    case "challenge:fail":
      keys = ["userId", "guildId", "action", "challengeId"];
      break;
    default:
      return false;
  }
  const actual = Object.keys(body);
  return (
    actual.length === keys.length &&
    keys.every((key) => actual.includes(key)) &&
    Object.values(body).every((value) => typeof value === "string")
  );
}

router.post("/verification/admin", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown> | undefined;
  if (
    !body ||
    Array.isArray(body) ||
    !hasActionShape(body) ||
    typeof body.userId !== "string" ||
    typeof body.guildId !== "string" ||
    !SNOWFLAKE_PATTERN.test(body.userId) ||
    !SNOWFLAKE_PATTERN.test(body.guildId) ||
    (body.action === "config:set" &&
      (typeof body.channelId !== "string" ||
        typeof body.verifiedRoleId !== "string" ||
        !SNOWFLAKE_PATTERN.test(body.channelId) ||
        !SNOWFLAKE_PATTERN.test(body.verifiedRoleId))) ||
    (body.action === "challenge:create" &&
      (typeof body.channelId !== "string" ||
        !SNOWFLAKE_PATTERN.test(body.channelId) ||
        typeof body.answerHash !== "string" ||
        !CAPTCHA_HASH_PATTERN.test(body.answerHash) ||
        typeof body.salt !== "string" ||
        !CAPTCHA_SALT_PATTERN.test(body.salt))) ||
    ((body.action === "challenge:verify" ||
      body.action === "challenge:complete" ||
      body.action === "challenge:fail") &&
      (typeof body.challengeId !== "string" ||
        !CAPTCHA_CHALLENGE_PATTERN.test(body.challengeId))) ||
    (body.action === "challenge:verify" &&
      (typeof body.answer !== "string" || body.answer.length > 16))
  ) {
    res.status(400).json({ error: "Invalid verification admin request." });
    return;
  }

  const timestampText = req.header("x-verification-timestamp") ?? "";
  const nonce = req.header("x-verification-nonce") ?? "";
  const suppliedSignature = req.header("x-verification-signature") ?? "";
  const timestamp = Number(timestampText);
  const now = new Date();
  const secret = process.env.VERIFICATION_BOT_HMAC_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    res.status(503).json({ error: "Verification is temporarily unavailable." });
    return;
  }
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now.getTime() - timestamp) > 5 * 60 * 1000 ||
    !NONCE_PATTERN.test(nonce) ||
    !SIGNATURE_PATTERN.test(suppliedSignature)
  ) {
    res.status(401).json({ error: "Invalid verification admin request." });
    return;
  }

  const bodyText = JSON.stringify(body);
  const expectedSignature = signBotAdminRequest(
    timestampText,
    nonce,
    bodyText,
    secret,
  );
  if (!safeEqual(expectedSignature, suppliedSignature.toLowerCase())) {
    res.status(401).json({ error: "Invalid verification admin request." });
    return;
  }
  if (
    !allowRateLimitedAttempt(
      `admin:${body.guildId}:${body.userId}`,
      30,
      60 * 1000,
    )
  ) {
    res.status(429).json({ error: "Too many verification admin requests." });
    return;
  }

  try {
    const {
      db,
      verificationBotNoncesTable,
      verificationGuildConfigsTable,
      verificationSessionsTable,
    } = await import("@workspace/db");

    if (MUTATING_ACTIONS.has(body.action)) {
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
        res.status(401).json({ error: "Invalid verification admin request." });
        return;
      }
    }

    switch (body.action) {
      case "diagnostics": {
        const missingSettings = getMissingVerificationSettings();
        const verificationConfigured = missingSettings.length === 0;

        let databaseConnected = false;
        let verificationSchemaReady = false;
        let guildConfig: Record<string, unknown> | null = null;
        try {
          await db.execute(sql`SELECT 1`);
          databaseConnected = true;
        } catch {
          req.log.error("Verification diagnostics database connection failed");
        }
        if (databaseConnected) {
          try {
            const [config] = await db
              .select()
              .from(verificationGuildConfigsTable)
              .where(eq(verificationGuildConfigsTable.guildId, body.guildId))
              .limit(1);
            await db
              .select({
                status: verificationSessionsTable.status,
                captchaAnswerHash: verificationSessionsTable.captchaAnswerHash,
                attemptCount: verificationSessionsTable.attemptCount,
              })
              .from(verificationSessionsTable)
              .limit(1);
            await db
              .select({ nonceHash: verificationBotNoncesTable.nonceHash })
              .from(verificationBotNoncesTable)
              .limit(1);
            verificationSchemaReady = true;
            guildConfig = config ?? null;
          } catch {
            req.log.error("Verification diagnostics schema check failed");
          }
        }

        res.json({
          hmacAuthenticated: true,
          databaseConnected,
          verificationSchemaReady,
          verificationConfigured,
          missingSettings,
          guildConfig,
          captchaRendering: {
            supported: true,
            provider: "Discord interaction and local bitmap image",
            note: "The bot validates glyph coverage through /verification test.",
          },
        });
        return;
      }

      case "config:get": {
        const [config] = await db
          .select()
          .from(verificationGuildConfigsTable)
          .where(eq(verificationGuildConfigsTable.guildId, body.guildId))
          .limit(1);
        res.json({ config: config ?? null });
        return;
      }

      case "config:set": {
        const currentTime = new Date();
        const [config] = await db
          .insert(verificationGuildConfigsTable)
          .values({
            guildId: body.guildId,
            channelId: body.channelId,
            verifiedRoleId: body.verifiedRoleId,
            enabled: true,
            updatedAt: currentTime,
          })
          .onConflictDoUpdate({
            target: verificationGuildConfigsTable.guildId,
            set: {
              channelId: body.channelId,
              verifiedRoleId: body.verifiedRoleId,
              enabled: true,
              updatedAt: currentTime,
            },
          })
          .returning();
        res.json({ config });
        return;
      }

      case "challenge:create": {
        if (
          !allowRateLimitedAttempt(
            `captcha:create:${body.guildId}:${body.userId}`,
            3,
            5 * 60 * 1000,
          )
        ) {
          res.status(429).json({
            error: "Please wait before requesting another CAPTCHA.",
            errorCode: "cooldown",
            retryAfterSeconds: 300,
          });
          return;
        }
        const [guildConfig] = await db
          .select()
          .from(verificationGuildConfigsTable)
          .where(eq(verificationGuildConfigsTable.guildId, body.guildId))
          .limit(1);
        if (
          !guildConfig?.enabled ||
          guildConfig.channelId !== body.channelId
        ) {
          res.status(403).json({ error: "Verification is not configured here." });
          return;
        }
        const [cooldown] = await db
          .select({ cooldownUntil: verificationSessionsTable.cooldownUntil })
          .from(verificationSessionsTable)
          .where(
            and(
              eq(verificationSessionsTable.guildId, body.guildId),
              eq(verificationSessionsTable.userId, body.userId),
              gt(verificationSessionsTable.cooldownUntil, now),
            ),
          )
          .orderBy(desc(verificationSessionsTable.updatedAt))
          .limit(1);
        if (cooldown?.cooldownUntil) {
          res.status(429).json({
            error: "Please wait before requesting another CAPTCHA.",
            errorCode: "cooldown",
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((cooldown.cooldownUntil.getTime() - now.getTime()) / 1000),
            ),
          });
          return;
        }

        await db
          .update(verificationSessionsTable)
          .set({ status: "invalidated", updatedAt: now })
          .where(
            and(
              eq(verificationSessionsTable.guildId, body.guildId),
              eq(verificationSessionsTable.userId, body.userId),
              eq(verificationSessionsTable.status, "captcha_pending"),
            ),
          );
        const challengeId = createOpaqueToken();
        const expiresAt = new Date(now.getTime() + CAPTCHA_TTL_MS);
        await db.insert(verificationSessionsTable).values({
          sessionHash: hashSecret(challengeId),
          userId: body.userId,
          guildId: body.guildId,
          status: "captcha_pending",
          captchaAnswerHash: body.answerHash,
          captchaSalt: body.salt,
          attemptCount: 0,
          expiresAt,
          updatedAt: now,
        });
        res.status(201).json({
          challengeId,
          expiresAt: expiresAt.toISOString(),
          maxAttempts: CAPTCHA_MAX_ATTEMPTS,
        });
        return;
      }

      case "challenge:verify": {
        if (
          !allowRateLimitedAttempt(
            `captcha:verify:${body.guildId}:${body.userId}`,
            12,
            60 * 1000,
          )
        ) {
          res.status(429).json({
            error: "Too many CAPTCHA attempts. Please wait before trying again.",
            errorCode: "cooldown",
            retryAfterSeconds: 60,
          });
          return;
        }
        const [challenge] = await db
          .select()
          .from(verificationSessionsTable)
          .where(
            and(
              eq(verificationSessionsTable.sessionHash, hashSecret(body.challengeId)),
              eq(verificationSessionsTable.userId, body.userId),
              eq(verificationSessionsTable.guildId, body.guildId),
            ),
          )
          .limit(1);
        if (!challenge) {
          res.status(404).json({
            verified: false,
            reason: "unavailable",
            attemptsRemaining: 0,
          });
          return;
        }
        if (challenge.cooldownUntil && challenge.cooldownUntil > now) {
          res.status(429).json({
            error: "Too many CAPTCHA attempts. Please wait before trying again.",
            errorCode: "cooldown",
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((challenge.cooldownUntil.getTime() - now.getTime()) / 1000),
            ),
          });
          return;
        }
        if (challenge.status !== "captcha_pending") {
          res.status(409).json({
            verified: false,
            reason: "unavailable",
            attemptsRemaining: 0,
          });
          return;
        }
        if (challenge.expiresAt <= now) {
          await db
            .update(verificationSessionsTable)
            .set({ status: "expired", updatedAt: now })
            .where(
              and(
                eq(verificationSessionsTable.sessionHash, challenge.sessionHash),
                eq(verificationSessionsTable.status, "captcha_pending"),
              ),
            );
          res.status(410).json({
            verified: false,
            reason: "expired",
            attemptsRemaining: 0,
          });
          return;
        }

        const normalizedAnswer = body.answer.trim().toUpperCase();
        const answerMatches =
          CAPTCHA_ANSWER_PATTERN.test(normalizedAnswer) &&
          Boolean(challenge.captchaSalt && challenge.captchaAnswerHash) &&
          safeEqual(
            createHmac("sha256", secret)
              .update(
                `captcha:${challenge.captchaSalt}:${normalizedAnswer}`,
                "utf8",
              )
              .digest("hex"),
            challenge.captchaAnswerHash ?? "",
          );
        if (!answerMatches) {
          const attempts = challenge.attemptCount + 1;
          const locked = attempts >= CAPTCHA_MAX_ATTEMPTS;
          const [updated] = await db
            .update(verificationSessionsTable)
            .set({
              attemptCount: attempts,
              status: locked ? "failed" : "captcha_pending",
              cooldownUntil: locked
                ? new Date(now.getTime() + CAPTCHA_COOLDOWN_MS)
                : null,
              updatedAt: now,
            })
            .where(
              and(
                eq(verificationSessionsTable.sessionHash, challenge.sessionHash),
                eq(verificationSessionsTable.status, "captcha_pending"),
                eq(verificationSessionsTable.attemptCount, challenge.attemptCount),
                gt(verificationSessionsTable.expiresAt, now),
              ),
            )
            .returning({ sessionHash: verificationSessionsTable.sessionHash });
          if (!updated) {
            res.status(409).json({
              verified: false,
              reason: "unavailable",
              attemptsRemaining: 0,
            });
            return;
          }
          res.json({
            verified: false,
            reason: locked ? "attempt_limit" : "incorrect",
            attemptsRemaining: Math.max(0, CAPTCHA_MAX_ATTEMPTS - attempts),
            cooldownSeconds: locked ? CAPTCHA_COOLDOWN_MS / 1000 : 0,
          });
          return;
        }

        const [accepted] = await db
          .update(verificationSessionsTable)
          .set({
            status: "captcha_passed",
            captchaAnswerHash: null,
            captchaSalt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(verificationSessionsTable.sessionHash, challenge.sessionHash),
              eq(verificationSessionsTable.status, "captcha_pending"),
              eq(verificationSessionsTable.attemptCount, challenge.attemptCount),
              gt(verificationSessionsTable.expiresAt, now),
            ),
          )
          .returning({ sessionHash: verificationSessionsTable.sessionHash });
        if (!accepted) {
          res.status(409).json({
            verified: false,
            reason: "unavailable",
            attemptsRemaining: 0,
          });
          return;
        }
        res.json({ verified: true });
        return;
      }

      case "challenge:complete":
      case "challenge:fail": {
        const completed = body.action === "challenge:complete";
        const [updated] = await db
          .update(verificationSessionsTable)
          .set({
            status: completed ? "verified" : "failed",
            cooldownUntil: completed
              ? null
              : new Date(now.getTime() + CAPTCHA_COOLDOWN_MS),
            updatedAt: now,
          })
          .where(
            and(
              eq(verificationSessionsTable.sessionHash, hashSecret(body.challengeId)),
              eq(verificationSessionsTable.userId, body.userId),
              eq(verificationSessionsTable.guildId, body.guildId),
              eq(verificationSessionsTable.status, "captcha_passed"),
            ),
          )
          .returning({ sessionHash: verificationSessionsTable.sessionHash });
        if (!updated) {
          res.status(409).json({ error: "Challenge is no longer available." });
          return;
        }
        res.json({ completed });
        return;
      }

      case "config:reset": {
        const deleted = await db
          .delete(verificationGuildConfigsTable)
          .where(eq(verificationGuildConfigsTable.guildId, body.guildId))
          .returning({ guildId: verificationGuildConfigsTable.guildId });
        res.json({ reset: deleted.length > 0 });
        return;
      }

      case "stats": {
        const rows = await db
          .select({
            status: verificationSessionsTable.status,
            count: count(),
          })
          .from(verificationSessionsTable)
          .where(eq(verificationSessionsTable.guildId, body.guildId))
          .groupBy(verificationSessionsTable.status);
        const counts = Object.fromEntries(
          rows.map((row) => [row.status, Number(row.count)]),
        );
        const total = Object.values(counts).reduce(
          (sum, value) => sum + value,
          0,
        );
        res.json({ counts, total });
        return;
      }

      case "sessions:reset": {
        const invalidated = await db
          .update(verificationSessionsTable)
          .set({ status: "invalidated", updatedAt: now })
          .where(
            and(
              eq(verificationSessionsTable.guildId, body.guildId),
              inArray(verificationSessionsTable.status, [
                "pending",
                "captcha_pending",
                "captcha_passed",
              ]),
            ),
          )
          .returning({ sessionHash: verificationSessionsTable.sessionHash });
        res.json({ invalidated: invalidated.length });
        return;
      }
    }
  } catch {
    req.log.error("Verification admin request failed");
    res.status(503).json({ error: "Verification is temporarily unavailable." });
  }
});

export default router;
