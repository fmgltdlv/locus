import type { Env } from "../types.js";

const DEFAULT_APP_ORIGIN = "https://app.example.com";
const DEFAULT_SUPPORT_EMAIL = "support@example.com";
const DEFAULT_TRANSACTIONAL_FROM = "noreply@your-domain.example";

export function supportEmail(env?: Env | null): string {
  const v = String(env?.SUPPORT_EMAIL || "").trim();
  return v || DEFAULT_SUPPORT_EMAIL;
}

export function transactionalFromEmail(env?: Env | null): string {
  const v = String(env?.TRANSACTIONAL_FROM_EMAIL || "").trim();
  return v || DEFAULT_TRANSACTIONAL_FROM;
}

export function supportContactPhrase(env?: Env | null): string {
  return `Contact ${supportEmail(env)} if you need help.`;
}

/** UI origin for signup/password-reset deep links (PASSWORD_RESET_ORIGIN). */
export function appFrontendOrigin(env: Env): string {
  const raw = String(env.PASSWORD_RESET_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_APP_ORIGIN;
  if (/\.html$/i.test(raw)) return raw.replace(/\/[^/]+\.html$/i, "");
  return raw;
}

export function signupPagePath(env: Env): string {
  return `${appFrontendOrigin(env)}/signup`;
}

export function passwordResetPagePath(env: Env): string {
  return `${appFrontendOrigin(env)}/reset-password.html`;
}