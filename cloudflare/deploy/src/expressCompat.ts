import type { Context, Next } from "hono";
import type { AuthUser, Env } from "./types.js";
import { accessControlAllowOrigin } from "./corsAllowOrigin.js";

/** Used when no auth middleware ran (e.g. geocoding proxy). */
const GUEST_USER: AuthUser = {
  id: -1,
  username: "",
  email: "",
  role: "operator",
  adminOrganizationIds: [],
  organizationIds: [],
};

export type ExpressLikeRequest = {
  user: AuthUser;
  /** JSON / form body — kept as `any` for Express-compat route handlers migrated from JS. */
  body: any;
  query: Record<string, string>;
  params: Record<string, string>;
  headers: Record<string, string>;
  ip: string;
  connection: { remoteAddress: string };
  /** Set by requireOrganization middleware (Express parity). */
  orgId?: number;
  /** Request path (set when needed by callers). */
  path?: string;
  /** Multer-style upload (multipart /media). */
  file?: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  };
};

/** D1 / SQLite may surface integers as bigint; JSON.stringify throws without a replacer. */
function safeJsonStringify(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export class ResShim {
  private statusCode = 200;
  private headers = new Headers();
  private encoder = new TextEncoder();
  private stream: TransformStream<Uint8Array, Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private resolved = false;
  private resolveResponse!: (r: Response) => void;
  readonly responsePromise: Promise<Response>;

  constructor(private readonly honoContext: Context) {
    this.responsePromise = new Promise((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  /** Ensures Express-compat Responses include CORS headers from Hono's cors middleware (c.res). */
  private mergeCorsFromContext(target: Headers) {
    try {
      for (const [k, v] of this.honoContext.res.headers.entries()) {
        const lk = k.toLowerCase();
        if (lk.startsWith("access-control-") || lk === "vary") {
          if (!target.has(k)) target.set(k, v);
        }
      }
    } catch (e) {
      console.error("[ResShim] mergeCorsFromContext:", e);
    }
    try {
      if (![...target.keys()].some((k) => k.toLowerCase() === "access-control-allow-origin")) {
        const v = accessControlAllowOrigin(this.honoContext as Context<{ Bindings: Env }>);
        if (v) target.set("Access-Control-Allow-Origin", v);
      }
    } catch (e) {
      console.error("[ResShim] accessControlAllowOrigin:", e);
    }
  }

  /**
   * Workers throw RangeError if status is not an integer in [200, 599], which leaves ResShim hung
   * if `resolved` was set before `new Response` (see pac-sync-settings / pacweb-accounts tails).
   */
  private normalizeStatus(code: number): number {
    const n = Math.trunc(Number(code));
    if (!Number.isFinite(n) || n < 200 || n > 599) return 500;
    return n;
  }

  /** Minimal 500 JSON — avoids reusing headers that might upset the runtime. */
  private resolveFallbackJson(message: string) {
    const h = new Headers({ "Content-Type": "application/json" });
    try {
      const v = accessControlAllowOrigin(this.honoContext as Context<{ Bindings: Env }>);
      if (v) h.set("Access-Control-Allow-Origin", v);
    } catch {
      /* ignore */
    }
    this.resolveResponse(new Response(JSON.stringify({ error: message }), { status: 500, headers: h }));
  }

  status(code: number) {
    const n = Math.trunc(Number(code));
    if (Number.isFinite(n) && n >= 200 && n <= 599) {
      this.statusCode = n;
    } else {
      this.statusCode = 500;
    }
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  flushHeaders() {
    if (this.resolved) return;
    if (!this.stream) {
      this.mergeCorsFromContext(this.headers);
      this.stream = new TransformStream();
      this.writer = this.stream.writable.getWriter();
      const st = this.normalizeStatus(this.statusCode);
      this.resolved = true;
      try {
        this.resolveResponse(new Response(this.stream.readable, { status: st, headers: this.headers }));
      } catch (e) {
        console.error("[ResShim] flushHeaders new Response failed:", e);
        try {
          this.resolveFallbackJson("Internal Server Error");
        } catch (e2) {
          console.error("[ResShim] flushHeaders fallback failed:", e2);
        }
      }
    }
  }

  async write(chunk: string) {
    if (!this.writer) this.flushHeaders();
    await this.writer!.write(this.encoder.encode(chunk));
  }

  sendBuffer(data: Uint8Array | ArrayBuffer) {
    if (this.resolved) return;
    const headers = new Headers(this.headers);
    this.mergeCorsFromContext(headers);
    const st = this.normalizeStatus(this.statusCode);
    const body = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.resolved = true;
    try {
      this.resolveResponse(new Response(body, { status: st, headers }));
    } catch (e) {
      console.error("[ResShim] sendBuffer new Response failed:", e);
      try {
        this.resolveFallbackJson("Internal Server Error");
      } catch (e2) {
        console.error("[ResShim] sendBuffer fallback failed:", e2);
      }
    }
  }

  json(obj: unknown) {
    if (this.resolved) return;
    const headers = new Headers(this.headers);
    this.mergeCorsFromContext(headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let st = this.normalizeStatus(this.statusCode);
    let body: string;
    try {
      body = safeJsonStringify(obj);
    } catch (e) {
      console.error("[ResShim] JSON.stringify failed:", e);
      body = safeJsonStringify({ error: "Could not serialize response" });
      st = 500;
    }
    this.resolved = true;
    try {
      const stFinal = this.normalizeStatus(st);
      this.resolveResponse(new Response(body, { status: stFinal, headers }));
    } catch (e) {
      console.error("[ResShim] new Response failed:", e, "status attempted:", st);
      try {
        this.resolveFallbackJson("Internal Server Error");
      } catch (e2) {
        console.error("[ResShim] fatal fallback:", e2);
        try {
          this.resolveResponse(new Response(null, { status: 500 }));
        } catch (e3) {
          console.error("[ResShim] fatal empty 500:", e3);
        }
      }
    }
  }

  end() {
    if (this.writer) {
      void this.writer.close();
    } else if (!this.resolved) {
      this.mergeCorsFromContext(this.headers);
      const st = this.normalizeStatus(this.statusCode);
      this.resolved = true;
      try {
        this.resolveResponse(new Response(null, { status: st, headers: this.headers }));
      } catch (e) {
        console.error("[ResShim] end new Response failed:", e);
        try {
          this.resolveFallbackJson("Internal Server Error");
        } catch (e2) {
          console.error("[ResShim] end fallback failed:", e2);
          try {
            this.resolveResponse(new Response(null, { status: 500 }));
          } catch (e3) {
            console.error("[ResShim] end fatal:", e3);
          }
        }
      }
    }
  }

  getResponse() {
    return this.responsePromise;
  }
}

/**
 * After callback-based DB (or any async) work that calls `res.json` / `res.status().json` on
 * ResShim, await the final Response. Prevents the Hono route from finishing before the callback
 * runs, which can trigger RangeError when `c.res` is merged (invalid status).
 * Call `done()` once after every code path that invokes `res`.
 */
export async function respondAfterDb(
  res: ResShim,
  work: (done: () => void) => void
): Promise<Response> {
  await new Promise<void>((resolve) => {
    work(() => resolve());
  });
  return res.getResponse();
}

export function buildExpressReq(c: Context): ExpressLikeRequest {
  const raw = c.req.query();
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    query[k] = Array.isArray(v) ? String(v[0]) : String(v ?? "");
  }
  const user = (c.get("user") as AuthUser | undefined) ?? GUEST_USER;
  let body: unknown = c.get("jsonBody");
  if (body === undefined) body = {};
  const orgFromVar = c.get("orgId") as number | undefined;
  const multerFile = c.get("multerFile") as ExpressLikeRequest["file"] | undefined;
  return {
    user,
    body,
    query,
    params: c.req.param() as Record<string, string>,
    headers: c.req.header(),
    ip: c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "0.0.0.0",
    connection: {
      remoteAddress: c.req.header("cf-connecting-ip") || "0.0.0.0",
    },
    orgId: orgFromVar ?? user.organizationId,
    file: multerFile,
  };
}

export async function jsonBodyMiddleware(c: Context, next: Next) {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD") {
    c.set("jsonBody", {});
    await next();
    return;
  }
  const ct = c.req.header("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      c.set("jsonBody", await c.req.json());
    } catch {
      c.set("jsonBody", {});
    }
  } else {
    c.set("jsonBody", {});
  }
  await next();
}

export async function expressReqResMiddleware(c: Context, next: Next) {
  const res = new ResShim(c);
  c.set("expressRes", res);
  try {
    const maybe: unknown = await next();
    if (maybe instanceof Response) return maybe;
    // If downstream returned via c.json/c.text/c.body, Hono finalized the context.
    // In that case never await ResShim, or the request can hang waiting forever.
    if (c.finalized && c.res) return c.res;
    return await res.getResponse();
  } catch (err) {
    console.error("[expressReqResMiddleware]", err);
    const cctx = c as Context<{ Bindings: Env }>;
    const h = new Headers({ "Content-Type": "application/json" });
    const v = accessControlAllowOrigin(cctx);
    if (v) h.set("Access-Control-Allow-Origin", v);
    const msg = err instanceof Error ? err.message : "Internal Server Error";
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: h });
  }
}
