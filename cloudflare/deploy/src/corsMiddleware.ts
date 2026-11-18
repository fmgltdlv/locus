/**
 * CORS for Cloudflare Workers — same behavior as hono/cors, but we never call
 * `c.header()` after `await next()` when the context is finalized. Hono does that
 * to append `Vary: Origin`, which runs `new Response(res.body, res)` and can throw
 * RangeError on Workers (see logs: pac-sync-settings / pacweb-accounts).
 */
import type { Context, MiddlewareHandler } from "hono";
import { requestOriginFromHono } from "./corsAllowOrigin.js";

type CorsOptions = {
  origin:
    | string
    | string[]
    | ((
        origin: string,
        c: Context
      ) => string | null | undefined | Promise<string | null | undefined>);
  allowMethods?: string[] | ((origin: string, c: Context) => string[] | Promise<string[]>);
  allowHeaders?: string[];
  maxAge?: number;
  credentials?: boolean;
  exposeHeaders?: string[];
};

export function corsWorkers(options?: CorsOptions): MiddlewareHandler {
  const defaults: CorsOptions = {
    origin: "*",
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"],
    allowHeaders: [],
    exposeHeaders: [],
  };
  const opts = { ...defaults, ...options };

  const findAllowOrigin = ((optsOrigin: CorsOptions["origin"]) => {
    if (typeof optsOrigin === "string") {
      if (optsOrigin === "*") {
        if (opts.credentials) {
          return (origin: string) => origin || null;
        }
        return () => optsOrigin;
      }
      return (origin: string) => (optsOrigin === origin ? origin : null);
    }
    if (typeof optsOrigin === "function") {
      return optsOrigin;
    }
    if (Array.isArray(optsOrigin)) {
      if (optsOrigin.length === 1 && optsOrigin[0] === "*") {
        if (opts.credentials) {
          return (origin: string) => origin || null;
        }
        return () => "*";
      }
      return (origin: string) => (optsOrigin.includes(origin) ? origin : null);
    }
    return () => null as string | null;
  })(opts.origin);

  const findAllowMethods = ((optsAllowMethods: CorsOptions["allowMethods"]) => {
    if (typeof optsAllowMethods === "function") {
      return optsAllowMethods;
    }
    if (Array.isArray(optsAllowMethods)) {
      return () => optsAllowMethods;
    }
    return () => [] as string[];
  })(opts.allowMethods);

  return async function corsWorkersHandler(c: Context, next) {
    function set(key: string, value: string) {
      c.res.headers.set(key, value);
    }

    function appendVaryOrigin() {
      const needs =
        opts.origin !== "*" || opts.credentials === true;
      if (!needs) return;
      const cur = c.res.headers.get("Vary");
      const parts = cur ? cur.split(",").map((s) => s.trim()) : [];
      if (!parts.includes("Origin")) {
        c.res.headers.append("Vary", "Origin");
      }
    }

    const allowOrigin = await findAllowOrigin(requestOriginFromHono(c) || "", c);
    if (allowOrigin) {
      set("Access-Control-Allow-Origin", allowOrigin);
    }
    if (opts.credentials) {
      set("Access-Control-Allow-Credentials", "true");
    }
    if (opts.exposeHeaders?.length) {
      set("Access-Control-Expose-Headers", opts.exposeHeaders.join(","));
    }

    if (c.req.method === "OPTIONS") {
      if (opts.origin !== "*" || opts.credentials) {
        set("Vary", "Origin");
      }
      if (opts.maxAge != null) {
        set("Access-Control-Max-Age", opts.maxAge.toString());
      }
      const allowMethods = await findAllowMethods(requestOriginFromHono(c) || "", c);
      if (allowMethods.length) {
        set("Access-Control-Allow-Methods", allowMethods.join(","));
      }
      let headers = opts.allowHeaders;
      if (!headers?.length) {
        const requestHeaders = c.req.header("Access-Control-Request-Headers");
        if (requestHeaders) {
          headers = requestHeaders.split(/\s*,\s*/);
        }
      }
      if (headers?.length) {
        set("Access-Control-Allow-Headers", headers.join(","));
        c.res.headers.append("Vary", "Access-Control-Request-Headers");
      }
      c.res.headers.delete("Content-Length");
      c.res.headers.delete("Content-Type");
      return new Response(null, {
        headers: c.res.headers,
        status: 204,
        statusText: "No Content",
      });
    }

    // Before next(): set Vary so we never need c.header() after the response is finalized.
    appendVaryOrigin();
    await next();

    // Handlers may replace c.res; re-apply allow-origin on the final response (avoid c.header() after next).
    const postOrigin = await findAllowOrigin(requestOriginFromHono(c) || "", c);
    if (postOrigin) {
      c.res.headers.set("Access-Control-Allow-Origin", postOrigin);
    }
    if (opts.credentials) {
      c.res.headers.set("Access-Control-Allow-Credentials", "true");
    }
    if (opts.exposeHeaders?.length) {
      c.res.headers.set("Access-Control-Expose-Headers", opts.exposeHeaders.join(","));
    }
    appendVaryOrigin();
  };
}
