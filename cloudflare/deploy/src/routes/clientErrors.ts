import { Hono } from "hono";
import { getDatabase } from "../database.js";
import { verifyToken } from "../auth.js";
import { normalizeGlobalRole } from "../lib/roles.js";
import { buildExpressReq, jsonBodyMiddleware } from "../expressCompat.js";
import type { AuthUser, Env } from "../types.js";
// @ts-ignore CJS
import { getRow } from "../lib/db.cjs";
// @ts-ignore CJS
import { createAppError, logErrorIncident } from "../lib/appErrors.cjs";
import {
  clientErrorRateBucketKey,
  isClientErrorRateLimitExceeded,
  recordClientErrorReport,
} from "../lib/clientErrorRateLimit.js";

const CLIENT_ERROR_CODES = new Set(["CLIENT_JS_ERROR", "CLIENT_UNHANDLED_REJECTION", "CLIENT_REPORTED"]);
const MAX_MESSAGE_LEN = 4000;
const MAX_STACK_LEN = 12000;
const MAX_META_JSON_LEN = 10000;
const MAX_URL_LEN = 2000;
const MAX_FILENAME_LEN = 500;
const MAX_SOURCE_LEN = 120;
const MAX_USER_AGENT_LEN = 500;

const clientErrors = new Hono<{ Bindings: Env; Variables: { user?: AuthUser | null; jsonBody: unknown } }>() as any;
clientErrors.use("*", jsonBodyMiddleware);

function requestIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for") ||
    "0.0.0.0"
  );
}

function clip(value: unknown, max: number): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function sanitizeMeta(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (!key || /password|token|authorization|secret|cookie/i.test(key)) continue;
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = typeof value === "string" ? value.slice(0, 500) : value;
      continue;
    }
    try {
      out[key] = JSON.parse(JSON.stringify(value));
    } catch {
      /* skip */
    }
  }
  try {
    const json = JSON.stringify(out);
    if (json.length > MAX_META_JSON_LEN) return null;
    return out;
  } catch {
    return null;
  }
}

async function resolveOptionalUser(c: {
  env: Env;
  req: { header: (name: string) => string | undefined };
}): Promise<AuthUser | null> {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!token) return null;

  const secret = String(c.env.JWT_SECRET || "").trim();
  if (!secret) return null;

  const decoded = await verifyToken(token, secret);
  if (!decoded || decoded.id == null) return null;

  const db = getDatabase();
  const row = await getRow(db, "SELECT role, session_version FROM users WHERE id = ?", [decoded.id]);
  if (!row) return null;

  const expectedSessionVersion = Number(row.session_version ?? 0);
  const tokenSessionVersion = Number(decoded.sessionVersion ?? 0);
  if (tokenSessionVersion !== expectedSessionVersion) return null;

  let role = normalizeGlobalRole(decoded.role ?? "operator");
  if (row.role) role = normalizeGlobalRole(String(row.role));

  return {
    id: Number(decoded.id),
    username: String(decoded.username ?? ""),
    email: String(decoded.email ?? ""),
    role,
    organizationId: decoded.organizationId != null ? Number(decoded.organizationId) : undefined,
    adminOrganizationIds: [],
    organizationIds: [],
  };
}

clientErrors.post("/", async (c) => {
  const req = buildExpressReq(c);
  const body = req.body || {};
  const db = getDatabase();
  const ip = requestIp(c);

  const user = await resolveOptionalUser(c);
  const bucketKey = await clientErrorRateBucketKey(user && user.id != null ? user.id : null, ip);

  if (await isClientErrorRateLimitExceeded(db, bucketKey)) {
    return c.json(
      {
        error: "Too many error reports. Please wait a moment and try again.",
        errorCode: "CLIENT_RATE_LIMITED",
      },
      429
    );
  }

  await recordClientErrorReport(db, bucketKey);

  const rawCode = clip(body.errorCode, 80) || "CLIENT_REPORTED";
  const errorCode = CLIENT_ERROR_CODES.has(rawCode) ? rawCode : "CLIENT_REPORTED";
  const message = clip(body.message, MAX_MESSAGE_LEN) || "Client error";
  const stack = clip(body.stack, MAX_STACK_LEN);
  const source = clip(body.source, MAX_SOURCE_LEN) || "client";
  const pageUrl = clip(body.pageUrl, MAX_URL_LEN);
  const filename = clip(body.filename, MAX_FILENAME_LEN);
  const userAgent = clip(body.userAgent, MAX_USER_AGENT_LEN) || clip(c.req.header("user-agent"), MAX_USER_AGENT_LEN);
  const line = body.line != null && Number.isFinite(Number(body.line)) ? Number(body.line) : null;
  const column = body.column != null && Number.isFinite(Number(body.column)) ? Number(body.column) : null;

  const meta = sanitizeMeta({
    ...(sanitizeMeta(body.meta) || {}),
    source,
    pageUrl,
    filename,
    line,
    column,
    userAgent,
    client: true,
  });

  const appErr = createAppError(errorCode, {
    internalMessage: message,
    detail: stack,
    meta,
  });

  const incidentId = await logErrorIncident(db, appErr, {
    route: `client.${source}`,
    requestMethod: "POST",
    requestPath: pageUrl || req.path || "/client-errors",
    userId: user && user.id != null ? user.id : null,
    organizationId: user && user.organizationId != null ? user.organizationId : null,
    status: appErr.status || 500,
    meta,
  });

  const response: Record<string, unknown> = { ok: true };
  if (incidentId) response.supportId = String(incidentId);
  return c.json(response);
});

export { clientErrors };
