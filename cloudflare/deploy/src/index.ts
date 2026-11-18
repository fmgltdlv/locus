import { Hono, type Context } from "hono";
import { corsWorkers } from "./corsMiddleware.js";
import { getDatabase, runWithDb } from "./database.js";
import { runWithWorkerContext } from "./envContext.js";
import { tickets, runScheduledUsanFullSync } from "./routes/tickets.js";
import { authRoutes } from "./routes/authRoutes.js";
import { organizations } from "./routes/organizations.js";
import { users } from "./routes/users.js";
import { userOrganizations } from "./routes/userOrganizations.js";
import { publicRoutes } from "./routes/public.js";
import { projectShareRoutes } from "./routes/projectShare.js";
import { serviceRequests } from "./routes/serviceRequests.js";
import { feed } from "./routes/feed.js";
import { geocoding } from "./routes/geocoding.js";
import { pacwebAccounts } from "./routes/pacwebAccounts.js";
import { credentialRepack } from "./routes/credentialRepack.js";
import { adminInbox } from "./routes/adminInbox.js";
import { clientErrors } from "./routes/clientErrors.js";
import { data } from "./routes/data.js";
import type { Env } from "./types.js";
import { SubmitJobWorkflow } from "./workflows/submitJobWorkflow.js";

export { SubmitJobWorkflow };
import {
  resolveCooperativeLockMs,
  resolveTicketDetailCoopLockMs,
  resolveEnableTicketRenewal,
} from "./lib/cooperativeLockMs.js";
import { readAppUiFlags } from "./routes/appSettingsAdmin.js";
import {
  accessControlAllowOrigin,
  BUILTIN_CORS_ORIGINS,
  effectiveCorsOrigins,
  isLocalDevBrowserOrigin,
  isProductionAppEnv,
} from "./corsAllowOrigin.js";
import { honoAppErrorResponse } from "./lib/appErrors.cjs";

function corsFromEnv(env: Env) {
  const eff = effectiveCorsOrigins(env.CORS_ORIGINS, env.APP_ENV);
  if (eff === "*") {
    return { origin: "*" as const, credentials: false as const };
  }
  return {
    origin: (requestOrigin: string) => {
      const origin = String(requestOrigin || "").trim().replace(/\/+$/, "");
      if (!origin) return null;
      if (eff.includes(origin)) return origin;
      if (isLocalDevBrowserOrigin(origin)) return origin;
      return null;
    },
    credentials: false as const,
  };
}

function logCorsConfigOnce(env: Env) {
  const g = globalThis as typeof globalThis & { __CORS_CONFIG_LOGGED__?: boolean };
  if (g.__CORS_CONFIG_LOGGED__) return;
  g.__CORS_CONFIG_LOGGED__ = true;
  const effective = effectiveCorsOrigins(env.CORS_ORIGINS, env.APP_ENV);
  const isWildcard = effective === "*";
  const list = isWildcard ? [] : effective;
  console.info("[cors-config]", {
    rawCORS_ORIGINS: env.CORS_ORIGINS ?? "",
    appEnv: env.APP_ENV ?? "",
    mode: isWildcard ? "wildcard" : "list",
    builtInOrigins: BUILTIN_CORS_ORIGINS,
    allowlistSize: isWildcard ? "any" : list.length,
    allowsLocalhost3000: isWildcard || list.includes("http://localhost:3000"),
    effectiveAllowlist: effective,
  });
}

/**
 * Hono CORS is applied in middleware; if an error happens *before* that middleware, or
 * the platform returns an exception path, the client sees "no CORS header" on 5xx. Apply
 * allow-origin to every error response when still missing.
 */
function allowOriginForRequest(c: Context<{ Bindings: Env }>) {
  const v = accessControlAllowOrigin(c);
  if (v) c.header("Access-Control-Allow-Origin", v);
}

const app = new Hono<{ Bindings: Env }>() as any;

// CORS must run before D1/ALS middleware so every response path (including 5xx) can carry Allow-Origin.
app.use("*", async (c, next) => {
  logCorsConfigOnce(c.env);
  const o = corsFromEnv(c.env);
  return corsWorkers({
    ...o,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    // Cache preflight per URL in the browser — cuts OPTIONS storms when many API calls run at once.
    maxAge: 86_400,
  })(c, next);
});

app.use("*", async (c, next) => {
  if (!c.env.DB) {
    allowOriginForRequest(c);
    return c.json({ error: "Database binding (DB) is not configured" }, 500);
  }
  if (!c.env.APP_KV) {
    console.warn("[worker] APP_KV not bound; app_kv, UI prefs, operator directory use D1 / degraded paths where implemented");
  }
  return runWithWorkerContext(c.env, () => runWithDb(c.env.DB, () => next()));
});

app.onError(async (err, c) => {
  allowOriginForRequest(c);
  let db = null;
  try {
    db = c.env.DB ? getDatabase() : null;
  } catch (_) {
    db = null;
  }
  return honoAppErrorResponse(c, db, err, {
    route: "worker.onError",
    requestMethod: c.req.method,
    requestPath: c.req.path,
  });
});

app.get("/health", (c) => c.json({ ok: true, service: "locus-worker" }));

/** Non-secret UI tuning for ticket refresh lock and feature flags. */
app.get("/api/public-config", async (c) => {
  const envTicketActions = resolveEnableTicketRenewal(c.env);
  let enableTicketRenewal = envTicketActions;
  let hideSiteDocumentation = false;
  let enableGuidedTour = false;
  let signupsClosed = false;
  try {
    const flags = await readAppUiFlags(getDatabase(), envTicketActions);
    enableTicketRenewal = flags.enableTicketActions;
    hideSiteDocumentation = flags.hideSiteDocumentation;
    enableGuidedTour = flags.enableGuidedTour;
    signupsClosed = flags.closeSignups;
  } catch (e) {
    console.warn("[public-config] app settings:", e);
  }
  return c.json({
    cooperativeLockMs: resolveCooperativeLockMs(c.env),
    ticketDetailCoopLockMs: resolveTicketDetailCoopLockMs(c.env),
    enableTicketRenewal,
    hideSiteDocumentation,
    enableGuidedTour,
    signupsClosed,
  });
});

app.route("/api/auth", authRoutes);
app.route("/api/organizations", organizations);
app.route("/api/organizations/:orgId/pacweb-accounts", pacwebAccounts);
app.route("/api/organizations/:orgId/ngen-accounts", pacwebAccounts);
app.route("/api/organizations/:orgId/source-accounts", pacwebAccounts);
app.route("/api/users", users);
app.route("/api/user-organizations", userOrganizations);
app.route("/api/public/project-share", projectShareRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/client-errors", clientErrors);
app.route("/api/service-requests", serviceRequests);
app.route("/api/feed", feed);
app.route("/api/geocoding", geocoding);
app.route("/api/data", data);
app.route("/api/tickets", tickets);

app.route("/api/admin", adminInbox);

/** Credential ciphertext bulk repack (protected by NGEN_CREDENTIAL_REPACK_SECRET). */
app.route("/api/internal", credentialRepack);

function isWorkerApiPath(pathname: string): boolean {
  return pathname === "/health" || pathname === "/api" || pathname.startsWith("/api/");
}

/** Public share URLs (`/share/{id}`) use share/index.html, not the app SPA shell. */
function shareAssetRequest(request: Request): Request | null {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/share" || path === "/share/") {
    url.pathname = "/share/index.html";
    return new Request(url.toString(), request);
  }
  if (path.startsWith("/share/") && path !== "/share/index.html" && !/\.[a-zA-Z0-9]+$/.test(path)) {
    url.pathname = "/share/index.html";
    return new Request(url.toString(), request);
  }
  return null;
}

/** Scheduled nGen list sync for one hub org (parity with backend/server.js node-cron) */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    if (!isWorkerApiPath(pathname) && env.ASSETS) {
      const shareReq = shareAssetRequest(request);
      return env.ASSETS.fetch(shareReq ?? request);
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        try {
          if (!env.APP_KV) {
            console.warn("[scheduled] APP_KV not bound; nGen list poll coordination keys use D1 fallback");
          }
          await runWithWorkerContext(env, () =>
            runWithDb(env.DB, async () => {
              await runScheduledUsanFullSync();
            })
          );
        } catch (e) {
          console.error("[scheduled] USAN full sync:", e);
        }
      })()
    );
  },
};
