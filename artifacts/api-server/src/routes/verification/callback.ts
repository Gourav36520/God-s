import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Router } from "express";
import { getVerificationConfig } from "../../lib/verification/config";
import {
  assertOAuthIdentity,
  hashSecret,
  optionalEmail,
  validateOAuthState,
} from "../../lib/verification/core";
import { encryptEmail } from "../../lib/verification/crypto";
import {
  clearCookie,
  configOrNull,
  COOKIE_OAUTH_STATE,
  cookieValue,
  failHtml,
  page,
  setPrivatePageHeaders,
  verificationDatabase,
} from "../../lib/verification/http";
import {
  sendPrivateVerificationEvent,
  type PrivateVerificationEvent,
} from "../../lib/verification/privateLog";
import { allowRateLimitedAttempt } from "../../lib/verification/rateLimit";

const router = Router();

interface DiscordTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
}

interface DiscordUserResponse {
  id?: unknown;
  username?: unknown;
  email?: unknown;
}

async function fetchDiscordUser(
  code: string,
  config: ReturnType<typeof getVerificationConfig>,
): Promise<DiscordUserResponse | null> {
  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.oauthClientId,
      client_secret: config.oauthClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.oauthCallbackUrl,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!tokenResponse.ok) return null;

  const tokenData = (await tokenResponse.json()) as DiscordTokenResponse;
  if (
    typeof tokenData.access_token !== "string" ||
    tokenData.token_type !== "Bearer"
  ) {
    return null;
  }

  const userResponse = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${tokenData.access_token}` },
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!userResponse.ok) return null;
  return (await userResponse.json()) as DiscordUserResponse;
}

router.get("/verification/callback", async (req, res): Promise<void> => {
  const config = configOrNull();
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const oauthError = typeof req.query.error === "string" ? req.query.error : "";

  if (
    !config ||
    !state ||
    state.length > 128 ||
    (!code && !oauthError) ||
    code.length > 4096
  ) {
    failHtml(res, 400, "Discord authorization could not be completed.");
    return;
  }
  if (oauthError.length > 128) {
    failHtml(res, 400, "Discord authorization could not be completed.");
    return;
  }
  if (!allowRateLimitedAttempt(`callback:${hashSecret(state)}`, 5, 10 * 60 * 1000)) {
    failHtml(res, 429, "Too many attempts. Request a new verification link in Discord.");
    return;
  }

  try {
    const {
      db,
      verificationGuildConfigsTable,
      verificationSessionsTable,
    } = await verificationDatabase();
    const stateHash = hashSecret(state);
    const [candidate] = await db
      .select()
      .from(verificationSessionsTable)
      .where(
        and(
          eq(verificationSessionsTable.oauthStateHash, stateHash),
          eq(verificationSessionsTable.status, "oauth_pending"),
        ),
      )
      .limit(1);

    if (
      !candidate ||
      !candidate.oauthStateExpiresAt ||
      !validateOAuthState(
        {
          stateHash,
          expiresAt: candidate.oauthStateExpiresAt,
          consumedAt: candidate.oauthStateConsumedAt,
        },
        state,
        cookieValue(req, COOKIE_OAUTH_STATE),
      )
    ) {
      failHtml(
        res,
        400,
        "This authorization response is invalid or has already been used.",
      );
      return;
    }

    const now = new Date();
    const [session] = await db
      .update(verificationSessionsTable)
      .set({
        status: "processing",
        oauthStateConsumedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(verificationSessionsTable.sessionHash, candidate.sessionHash),
          eq(verificationSessionsTable.status, "oauth_pending"),
          eq(verificationSessionsTable.oauthStateHash, stateHash),
          isNull(verificationSessionsTable.oauthStateConsumedAt),
          gt(verificationSessionsTable.oauthStateExpiresAt, now),
          gt(verificationSessionsTable.expiresAt, now),
        ),
      )
      .returning();

    clearCookie(res, COOKIE_OAUTH_STATE);
    if (!session) {
      failHtml(
        res,
        400,
        "This authorization response is invalid or has already been used.",
      );
      return;
    }
    if (oauthError || !code) {
      await db
        .update(verificationSessionsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(verificationSessionsTable.sessionHash, session.sessionHash));
      failHtml(res, 400, "Discord authorization was not completed.");
      return;
    }

    const discordUser = await fetchDiscordUser(code, config);
    if (
      !discordUser ||
      typeof discordUser.id !== "string" ||
      typeof discordUser.username !== "string"
    ) {
      await db
        .update(verificationSessionsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(verificationSessionsTable.sessionHash, session.sessionHash));
      failHtml(res, 400, "Discord authorization could not be completed.");
      return;
    }

    try {
      assertOAuthIdentity(session.userId, discordUser.id);
    } catch {
      await db
        .update(verificationSessionsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(verificationSessionsTable.sessionHash, session.sessionHash));
      req.log.warn("Discord OAuth account did not match the requesting account");
      failHtml(
        res,
        403,
        "The Discord account does not match the account that requested verification.",
      );
      return;
    }

    const [guildConfig] = await db
      .select()
      .from(verificationGuildConfigsTable)
      .where(eq(verificationGuildConfigsTable.guildId, session.guildId))
      .limit(1);
    const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
    if (!guildConfig?.enabled || !botToken) {
      await db
        .update(verificationSessionsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(verificationSessionsTable.sessionHash, session.sessionHash));
      req.log.error("Verification guild role configuration is unavailable");
      failHtml(
        res,
        503,
        "Verification could not be completed. Please contact a server moderator.",
      );
      return;
    }

    const email = optionalEmail(discordUser.email);
    const verifiedAt = new Date();
    const eventId = randomUUID();
    const usernameSnapshot = discordUser.username.slice(0, 100);
    const event: PrivateVerificationEvent = {
      eventId,
      discordUserId: session.userId,
      guildId: session.guildId,
      usernameSnapshot,
      verificationTimestamp: verifiedAt.toISOString(),
      result: "verified",
      email,
      cloudflareRayId: null,
      retentionDays: config.retentionDays,
    };

    if (
      !(await sendPrivateVerificationEvent(
        config.privateLogUrl,
        config.privateLogHmacSecret,
        event,
      ))
    ) {
      await db
        .update(verificationSessionsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(verificationSessionsTable.sessionHash, session.sessionHash));
      req.log.error("Private verification logging endpoint did not accept the event");
      failHtml(
        res,
        503,
        "Verification could not be completed. Please request a new link in Discord.",
      );
      return;
    }

    let roleResponse: Response;
    try {
      roleResponse = await fetch(
        `https://discord.com/api/v10/guilds/${session.guildId}/members/${session.userId}/roles/${guildConfig.verifiedRoleId}`,
        {
          method: "PUT",
          headers: { authorization: `Bot ${botToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch {
      roleResponse = new Response(null, { status: 503 });
    }
    if (roleResponse.status !== 204) {
      await db
        .update(verificationSessionsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(verificationSessionsTable.sessionHash, session.sessionHash));
      req.log.error("Discord did not accept the verified-role assignment");
      failHtml(
        res,
        503,
        "Your account was verified, but the server role could not be assigned. Please contact a server moderator.",
      );
      return;
    }

    const [completed] = await db
      .update(verificationSessionsTable)
      .set({
        status: "verified",
        usernameSnapshot,
        emailEncrypted: email
          ? encryptEmail(email, config.emailEncryptionKey)
          : null,
        verifiedAt,
        eventId,
        privateLogDeliveredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(verificationSessionsTable.sessionHash, session.sessionHash),
          eq(verificationSessionsTable.status, "processing"),
        ),
      )
      .returning({ sessionHash: verificationSessionsTable.sessionHash });

    if (!completed) {
      req.log.error("Could not persist a completed verification");
      failHtml(
        res,
        503,
        "Verification could not be completed. Please request a new link in Discord.",
      );
      return;
    }

    setPrivatePageHeaders(res);
    res.status(200).type("html").send(
      page(
        "Verification complete",
        "<p>Your Discord account has been verified. You can close this page and return to Discord.</p>",
      ),
    );
  } catch {
    req.log.error("Verification callback failed");
    failHtml(
      res,
      503,
      "Verification could not be completed. Please request a new link in Discord.",
    );
  }
});

export default router;
