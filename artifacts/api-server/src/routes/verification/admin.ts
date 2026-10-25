import { and, count, eq, sql } from "drizzle-orm";
import { Router } from "express";
import {
  getMissingVerificationSettings,
  getVerificationConfig,
} from "../../lib/verification/config";
import { signBotAdminRequest } from "../../lib/verification/crypto";
import { hashSecret, safeEqual } from "../../lib/verification/core";
import { allowRateLimitedAttempt } from "../../lib/verification/rateLimit";

const router = Router();
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;
const MUTATING_ACTIONS = new Set([
  "config:set",
  "config:reset",
  "sessions:reset",
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
        !SNOWFLAKE_PATTERN.test(body.verifiedRoleId)))
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
        let verificationConfigured = false;
        try {
          getVerificationConfig();
          verificationConfigured = true;
        } catch {
          if (missingSettings.length === 0) {
            missingSettings.push("Verification configuration values");
          }
        }

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
              .select({ status: verificationSessionsTable.status })
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
          botTokenConfigured: Boolean(process.env.DISCORD_BOT_TOKEN?.trim()),
          missingSettings,
          guildConfig,
          captchaRendering: {
            supported: false,
            provider: "Cloudflare Turnstile",
            note: "This implementation has no local bitmap CAPTCHA renderer.",
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
              eq(verificationSessionsTable.status, "pending"),
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
