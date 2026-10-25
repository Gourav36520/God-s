import { and, eq, gt, isNull } from "drizzle-orm";
import { Router } from "express";
import {
  COOKIE_CSRF,
  clearCookie,
  configOrNull,
  cookieValue,
  expiredResponse,
  failHtml,
  escapeHtml,
  page,
  SESSION_PATTERN,
  setCookie,
  setPrivatePageHeaders,
  verificationDatabase,
} from "../../lib/verification/http";
import {
  createOpaqueToken,
  hashSecret,
  isExpired,
  safeEqual,
  VERIFICATION_SESSION_TTL_MS,
  OAUTH_STATE_TTL_MS,
} from "../../lib/verification/core";
import { allowRateLimitedAttempt } from "../../lib/verification/rateLimit";
import { verifyTurnstileToken } from "../../lib/verification/turnstile";

const router = Router();

router.get("/verify", async (req, res): Promise<void> => {
  const config = configOrNull();
  const sessionId = typeof req.query.session === "string" ? req.query.session : "";
  if (
    !config ||
    Object.keys(req.query).length !== 1 ||
    !Object.hasOwn(req.query, "session") ||
    !SESSION_PATTERN.test(sessionId)
  ) {
    failHtml(res, 404, "This verification link is invalid or unavailable.");
    return;
  }
  if (
    !allowRateLimitedAttempt(
      `page:${hashSecret(sessionId)}`,
      20,
      10 * 60 * 1000,
    )
  ) {
    failHtml(res, 429, "Too many attempts. Please try again later.");
    return;
  }

  try {
    const { db, verificationSessionsTable } = await verificationDatabase();
    const sessionHash = hashSecret(sessionId);
    const [session] = await db
      .select()
      .from(verificationSessionsTable)
      .where(eq(verificationSessionsTable.sessionHash, sessionHash))
      .limit(1);
    if (!session || session.status !== "pending") {
      failHtml(
        res,
        404,
        "This verification link is invalid or has already been used.",
      );
      return;
    }
    if (isExpired(session.expiresAt)) {
      await db
        .update(verificationSessionsTable)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            eq(verificationSessionsTable.sessionHash, sessionHash),
            eq(verificationSessionsTable.status, "pending"),
          ),
        );
      expiredResponse(res);
      return;
    }

    const csrfToken = createOpaqueToken();
    const [updated] = await db
      .update(verificationSessionsTable)
      .set({ csrfTokenHash: hashSecret(csrfToken), updatedAt: new Date() })
      .where(
        and(
          eq(verificationSessionsTable.sessionHash, sessionHash),
          eq(verificationSessionsTable.status, "pending"),
          gt(verificationSessionsTable.expiresAt, new Date()),
        ),
      )
      .returning({ sessionHash: verificationSessionsTable.sessionHash });
    if (!updated) {
      expiredResponse(res);
      return;
    }

    setPrivatePageHeaders(res);
    setCookie(res, COOKIE_CSRF, csrfToken, 10 * 60);
    const content = `<p>This check confirms that the Discord account which requested this link is the account completing verification.</p>
<ul>
  <li>We record your Discord user ID, username snapshot, server ID, and verification timestamp to record the result.</li>
  <li>Discord email is optional. We store it only if Discord returns it after authorization; otherwise it is recorded as unavailable.</li>
  <li><strong>Client IP is not collected by this flow.</strong></li>
  <li>Verification and private audit records are configured for deletion after ${config.retentionDays} days. The private logging service must enforce the same retention period; local verification records are purged hourly.</li>
</ul>
<p class="notice">Continuing sends you to Discord to authorize the <strong>identify</strong> and <strong>email</strong> scopes. Your email is not shown in the browser or posted to Discord.</p>
<form method="post" action="/api/verification/consent" autocomplete="off">
  <input type="hidden" name="session" value="${escapeHtml(sessionId)}">
  <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
  <div class="cf-turnstile" data-sitekey="${escapeHtml(config.turnstileSiteKey)}" data-action="verify"></div>
  <label class="consent"><input type="checkbox" name="consent" value="yes" required><span>I have read this notice and consent to this verification processing.</span></label>
  <button type="submit">Continue with Discord</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
    res.type("html").send(page("Discord verification", content));
  } catch {
    req.log.error("Could not load a verification session");
    failHtml(res, 503, "Verification is temporarily unavailable.");
  }
});

router.post("/verification/consent", async (req, res): Promise<void> => {
  const config = configOrNull();
  const body = req.body as Record<string, unknown> | undefined;
  const sessionId = typeof body?.session === "string" ? body.session : "";
  const csrfToken = typeof body?.csrfToken === "string" ? body.csrfToken : "";
  const turnstileToken =
    typeof body?.["cf-turnstile-response"] === "string"
      ? body["cf-turnstile-response"]
      : "";

  if (
    !config ||
    !SESSION_PATTERN.test(sessionId) ||
    body?.consent !== "yes" ||
    !csrfToken ||
    csrfToken.length > 128 ||
    !turnstileToken ||
    turnstileToken.length > 2048
  ) {
    failHtml(
      res,
      400,
      "The request could not be verified. Reload the link and try again.",
    );
    return;
  }
  if (
    !allowRateLimitedAttempt(
      `consent:${hashSecret(sessionId)}`,
      5,
      10 * 60 * 1000,
    )
  ) {
    failHtml(res, 429, "Too many attempts. Please try again later.");
    return;
  }

  try {
    const { db, verificationSessionsTable } = await verificationDatabase();
    const sessionHash = hashSecret(sessionId);
    const [session] = await db
      .select()
      .from(verificationSessionsTable)
      .where(eq(verificationSessionsTable.sessionHash, sessionHash))
      .limit(1);
    if (!session || session.status !== "pending") {
      failHtml(
        res,
        404,
        "This verification link is invalid or has already been used.",
      );
      return;
    }
    if (isExpired(session.expiresAt)) {
      await db
        .update(verificationSessionsTable)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(verificationSessionsTable.sessionHash, sessionHash));
      expiredResponse(res);
      return;
    }

    const csrfCookie = cookieValue(req, COOKIE_CSRF);
    if (
      !csrfCookie ||
      !safeEqual(csrfCookie, csrfToken) ||
      !session.csrfTokenHash ||
      !safeEqual(hashSecret(csrfToken), session.csrfTokenHash)
    ) {
      failHtml(
        res,
        403,
        "The request could not be verified. Reload the link and try again.",
      );
      return;
    }

    if (
      !(await verifyTurnstileToken(
        turnstileToken,
        config.turnstileSecretKey,
        config.expectedHostname,
      ))
    ) {
      failHtml(
        res,
        400,
        "The security check failed. Reload the link and try again.",
      );
      return;
    }

    const now = new Date();
    const state = createOpaqueToken();
    const stateExpiresAt = new Date(
      Math.min(now.getTime() + OAUTH_STATE_TTL_MS, session.expiresAt.getTime()),
    );
    const [updated] = await db
      .update(verificationSessionsTable)
      .set({
        status: "oauth_pending",
        consentedAt: now,
        csrfTokenHash: null,
        oauthStateHash: hashSecret(state),
        oauthStateExpiresAt: stateExpiresAt,
        oauthStateConsumedAt: null,
        turnstileTokenHash: hashSecret(turnstileToken),
        updatedAt: now,
      })
      .where(
        and(
          eq(verificationSessionsTable.sessionHash, sessionHash),
          eq(verificationSessionsTable.status, "pending"),
          eq(verificationSessionsTable.csrfTokenHash, session.csrfTokenHash),
          isNull(verificationSessionsTable.turnstileTokenHash),
          gt(verificationSessionsTable.expiresAt, now),
        ),
      )
      .returning({ sessionHash: verificationSessionsTable.sessionHash });

    if (!updated) {
      failHtml(res, 409, "This verification link has already been used.");
      return;
    }

    const stateCookieAge = Math.max(
      1,
      Math.floor((stateExpiresAt.getTime() - now.getTime()) / 1000),
    );
    setCookie(res, "verification_oauth_state", state, stateCookieAge);
    clearCookie(res, COOKIE_CSRF);

    const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
    authorizeUrl.searchParams.set("client_id", config.oauthClientId);
    authorizeUrl.searchParams.set("redirect_uri", config.oauthCallbackUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "identify email");
    authorizeUrl.searchParams.set("state", state);
    res.redirect(302, authorizeUrl.toString());
  } catch {
    req.log.error("Could not begin Discord authorization");
    failHtml(res, 503, "Verification is temporarily unavailable.");
  }
});

export default router;
