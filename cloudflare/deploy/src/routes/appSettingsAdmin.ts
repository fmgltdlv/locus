import { getDatabase } from "../database.js";
import { authorizeMiddleware } from "../auth.js";
import { buildExpressReq } from "../expressCompat.js";
import { getAppKv, setAppKv } from "../lib/appKv.js";
import { resolveEnableTicketRenewal } from "../lib/cooperativeLockMs.js";
import { createAppError, honoAppErrorResponse } from "../lib/appErrors.cjs";

/** Missing or any value other than "0" means the Public sharing admin tab stays visible. */
export const SHOW_PUBLIC_SHARING_TAB_KEY = "admin_ui:show_public_sharing_tab";

/** "1" on, "0" off. Missing falls back to wrangler ENABLE_TICKET_RENEWAL. */
export const ENABLE_TICKET_ACTIONS_KEY = "app_ui:enable_ticket_actions";

/** Only the exact value "1" hides Request Services and blocks new submissions. */
export const HIDE_SITE_DOCUMENTATION_KEY = "app_ui:hide_site_documentation";

/** Only the exact value "1" turns the guided tour on. */
export const ENABLE_GUIDED_TOUR_KEY = "app_ui:enable_guided_tour";

/** Only the exact value "1" closes new signups. */
export const CLOSE_SIGNUPS_KEY = "app_ui:close_signups";

export type AppUiFlags = {
  showPublicSharingTab: boolean;
  enableTicketActions: boolean;
  hideSiteDocumentation: boolean;
  enableGuidedTour: boolean;
  closeSignups: boolean;
};

export function showPublicSharingTabFromRaw(raw: string | null): boolean {
  return raw !== "0";
}

function exactOne(raw: string | null): boolean {
  return raw === "1";
}

/** Saved "1"/"0" wins. Missing or unreadable uses the wrangler fallback. */
export async function resolveEnableTicketActions(db: unknown, envFallback: boolean): Promise<boolean> {
  try {
    const raw = await getAppKv(db, ENABLE_TICKET_ACTIONS_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch (e) {
    console.warn("[app-settings] ticket actions:", e);
  }
  return envFallback;
}

export async function readAppUiFlags(db: unknown, envTicketActionsFallback: boolean): Promise<AppUiFlags> {
  const [sharingRaw, ticketRaw, siteRaw, tourRaw, signupRaw] = await Promise.all([
    getAppKv(db, SHOW_PUBLIC_SHARING_TAB_KEY),
    getAppKv(db, ENABLE_TICKET_ACTIONS_KEY),
    getAppKv(db, HIDE_SITE_DOCUMENTATION_KEY),
    getAppKv(db, ENABLE_GUIDED_TOUR_KEY),
    getAppKv(db, CLOSE_SIGNUPS_KEY),
  ]);
  let enableTicketActions = envTicketActionsFallback;
  if (ticketRaw === "1") enableTicketActions = true;
  else if (ticketRaw === "0") enableTicketActions = false;
  return {
    showPublicSharingTab: showPublicSharingTabFromRaw(sharingRaw),
    enableTicketActions,
    hideSiteDocumentation: exactOne(siteRaw),
    enableGuidedTour: exactOne(tourRaw),
    closeSignups: exactOne(signupRaw),
  };
}

const APP_SETTING_FIELDS = [
  ["showPublicSharingTab", SHOW_PUBLIC_SHARING_TAB_KEY],
  ["enableTicketActions", ENABLE_TICKET_ACTIONS_KEY],
  ["hideSiteDocumentation", HIDE_SITE_DOCUMENTATION_KEY],
  ["enableGuidedTour", ENABLE_GUIDED_TOUR_KEY],
  ["closeSignups", CLOSE_SIGNUPS_KEY],
] as const;

async function getAppSettings(c) {
  try {
    const flags = await readAppUiFlags(getDatabase(), resolveEnableTicketRenewal(c.env));
    return c.json(flags);
  } catch (e) {
    console.error("[app-settings] GET:", e);
    return honoAppErrorResponse(c, getDatabase(), createAppError("APP_UNEXPECTED", {
      internalMessage: e.message || String(e),
      customerMessage: "App settings could not be loaded. Please try again.",
      status: 500,
    }), { route: "admin.appSettings.get" });
  }
}

async function putAppSettings(c) {
  const req = buildExpressReq(c);
  if (!req.user || req.user.role !== "dev") {
    return c.json({ error: "Only developers can change app settings." }, 403);
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const updates: { key: string; value: boolean }[] = [];
  for (const [field, key] of APP_SETTING_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    if (typeof body[field] !== "boolean") {
      return c.json({ error: `${field} must be true or false.` }, 400);
    }
    updates.push({ key, value: body[field] });
  }
  if (updates.length === 0) {
    return c.json({ error: "Send at least one app setting as true or false." }, 400);
  }
  try {
    const db = getDatabase();
    for (const update of updates) {
      await setAppKv(db, update.key, update.value ? "1" : "0");
    }
    const flags = await readAppUiFlags(db, resolveEnableTicketRenewal(c.env));
    return c.json({ ok: true, ...flags });
  } catch (e) {
    console.error("[app-settings] PUT:", e);
    return honoAppErrorResponse(c, getDatabase(), createAppError("APP_UNEXPECTED", {
      internalMessage: e.message || String(e),
      customerMessage: "App settings could not be saved. Please try again.",
      status: 500,
    }), { route: "admin.appSettings.put" });
  }
}

const am = authorizeMiddleware("dev", "admin");

export { getAppSettings, putAppSettings, am };
