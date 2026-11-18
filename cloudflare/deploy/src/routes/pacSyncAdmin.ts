import { getDatabase } from "../database.js";
import { authorizeMiddleware } from "../auth.js";
import { buildExpressReq } from "../expressCompat.js";
import {
  clampDaysBack,
  getPacRuntimeSettings,
  getUsanListLookbackMaxDays,
  MAX_DAYS_BACK,
  setPacRuntimeSettings,
} from "../lib/pacRuntimeSettings.cjs";
import { runPacwebPollCore } from "./tickets.js";
import { createAppError, honoAppErrorResponse } from "../lib/appErrors.cjs";

/**
 * nGen list sync settings. Legacy: GET /pac-sync-settings
 * Use `expressRes` (see expressCompat), not c.json — mixing c.json with `expressReqResMiddleware` can yield invalid/concatenated JSON bodies.
 */
async function getSyncSettings(c) {
  try {
    const req = buildExpressReq(c);
    const isDev = !!(req.user && req.user.role === "dev");
    const db = getDatabase();
    const s = await getPacRuntimeSettings(db);
    return c.json({
      daysBack: s.daysBack,
      maxDaysBack: isDev ? getUsanListLookbackMaxDays() : MAX_DAYS_BACK,
      standardMaxDaysBack: MAX_DAYS_BACK,
    });
  } catch (e) {
    console.error("[usan-sync-settings] GET:", e);
    return honoAppErrorResponse(c, getDatabase(), createAppError("APP_UNEXPECTED", {
      internalMessage: e.message || String(e),
      customerMessage: "External sync settings could not be loaded. Please try again.",
      status: 500,
    }), { route: "admin.usanSyncSettings.get" });
  }
}

/** Canonical. Legacy: PUT /pac-sync-settings */
async function putSyncSettings(c) {
  const req = buildExpressReq(c);
  if (!req.user || req.user.role !== "dev") {
    return c.json({ error: "Only dev can save nGen sync settings." }, 403);
  }
  try {
    const db = getDatabase();
    await setPacRuntimeSettings(
      db,
      {
        daysBack: req.body && req.body.daysBack,
      },
      { dev: true }
    );
    const s = await getPacRuntimeSettings(db);
    return c.json({
      ok: true,
      daysBack: s.daysBack,
      maxDaysBack: getUsanListLookbackMaxDays(),
      standardMaxDaysBack: MAX_DAYS_BACK,
    });
  } catch (e) {
    console.error("[usan-sync-settings] PUT:", e);
    return honoAppErrorResponse(c, getDatabase(), createAppError("APP_UNEXPECTED", {
      internalMessage: e.message || String(e),
      customerMessage: "External sync settings could not be saved. Please try again.",
      status: 500,
    }), { route: "admin.usanSyncSettings.put" });
  }
}

/** Full window nGen list import for one org. Legacy: POST /pac-full-sync */
async function postFullListSync(c) {
  const req = buildExpressReq(c);
  try {
    req.body = req.body && typeof req.body === "object" ? req.body : {};
    req.body.fullSync = true;
    if (req.body.organizationId == null && req.user.organizationId) {
      req.body.organizationId = req.user.organizationId;
    }
    if (req.body.organizationId == null) {
      const err = createAppError("EXTERNAL_SYNC_ORG_REQUIRED", {
        internalMessage: "organizationId is required for full USAN/nGen list sync",
      });
      return honoAppErrorResponse(c, getDatabase(), err, { req, route: "admin.usanFullSync.organizationRequired" });
    }
    const out = await runPacwebPollCore(req, {});
    if (out.kind === "error") {
      return c.json(out.body, out.status);
    }
    return c.json(out.result);
  } catch (e) {
    console.error("[usan-full-sync]:", e);
    return honoAppErrorResponse(c, getDatabase(), createAppError("EXTERNAL_SYNC_FAILED", {
      internalMessage: e.message || String(e),
      cause: e,
    }), { req, route: "admin.usanFullSync" });
  }
}

const am = authorizeMiddleware("dev", "admin");

/** Handlers and `am` are mounted in `adminInbox.ts` (exposed as `/api/admin/...` via `app.route` in `index.ts`). */
export { getSyncSettings, putSyncSettings, postFullListSync, am };
