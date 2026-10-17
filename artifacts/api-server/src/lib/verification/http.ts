import { type Request, type Response } from "express";
import { logger } from "../logger";
import {
  getVerificationConfig,
  VerificationConfigurationError,
} from "./config";

export const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const COOKIE_CSRF = "verification_csrf";
export const COOKIE_OAUTH_STATE = "verification_oauth_state";
export const COOKIE_PATH = "/api/verification";

export async function verificationDatabase() {
  return import("@workspace/db");
}

export function failHtml(res: Response, status: number, message: string): void {
  setPrivatePageHeaders(res);
  res
    .status(status)
    .type("html")
    .send(page("Verification", `<p>${escapeHtml(message)}</p>`));
}

export function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; background: #f4f6f9; color: #18212f; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    main { width: min(100%, 560px); box-sizing: border-box; padding: 32px; border-radius: 16px; background: white; box-shadow: 0 12px 36px #14213d18; }
    h1 { margin: 0 0 16px; font-size: 1.55rem; } p, li { line-height: 1.55; }
    ul { padding-left: 22px; } button { border: 0; border-radius: 8px; padding: 12px 18px; background: #5865f2; color: white; font: inherit; font-weight: 650; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; } .notice { padding: 12px 14px; border-radius: 8px; background: #f1f4fa; }
    label.consent { display: flex; gap: 10px; align-items: flex-start; margin: 20px 0; } .consent input { margin-top: 5px; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${content}</main></body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

export function setPrivatePageHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; form-action 'self' https://discord.com; base-uri 'none'; frame-ancestors 'none'",
  );
}

export function setCookie(
  res: Response,
  name: string,
  value: string,
  maxAgeSeconds: number,
): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

export function clearCookie(res: Response, name: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${name}=; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0${secure}`,
  );
}

export function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function hasExactKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

export function configOrNull(): ReturnType<typeof getVerificationConfig> | null {
  try {
    return getVerificationConfig();
  } catch (error) {
    if (!(error instanceof VerificationConfigurationError)) {
      logger.error("Verification configuration could not be loaded");
    }
    return null;
  }
}

export function expiredResponse(res: Response): void {
  failHtml(
    res,
    410,
    "This verification link has expired. Request a new link in Discord.",
  );
}
