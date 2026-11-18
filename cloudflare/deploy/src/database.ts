/**
 * Per-request D1 access compatible with legacy sqlite3 callback style (run/get/all).
 * Used with AsyncLocalStorage so ported backend code can call getDatabase() safely on Workers.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { D1Database } from "@cloudflare/workers-types";

export type SqliteLike = {
  run(
    sql: string,
    params: unknown[] | ((err: Error | null, ctx?: { changes: number; lastID: number }) => void),
    cb?: (err: Error | null, ctx?: { changes: number; lastID: number }) => void
  ): void;
  get(
    sql: string,
    params: unknown[] | ((err: Error | null, row?: Record<string, unknown>) => void),
    cb?: (err: Error | null, row?: Record<string, unknown>) => void
  ): void;
  all(
    sql: string,
    params: unknown[] | ((err: Error | null, rows?: Record<string, unknown>[]) => void),
    cb?: (err: Error | null, rows?: Record<string, unknown>[]) => void
  ): void;
};

const als = new AsyncLocalStorage<SqliteLike>();

export function runWithDb<T>(db: D1Database, fn: () => T): T {
  const adapter = createSqliteAdapter(db);
  return als.run(adapter, fn);
}

/** Legacy name used across ported routes and libs */
export function getDatabase(): SqliteLike {
  const db = als.getStore();
  if (!db) {
    throw new Error("getDatabase() called outside request context (missing runWithDb middleware)");
  }
  return db;
}

export function createSqliteAdapter(d1: D1Database): SqliteLike {
  return {
    run(sql, params, cb) {
      let p: unknown[] = [];
      let callback: (err: Error | null, ctx?: { changes: number; lastID: number }) => void;
      if (typeof params === "function") {
        callback = params as (err: Error | null, ctx?: { changes: number; lastID: number }) => void;
        p = [];
      } else {
        p = params || [];
        callback = cb as (err: Error | null, ctx?: { changes: number; lastID: number }) => void;
      }
      d1.prepare(sql)
        .bind(...p)
        .run()
        .then((meta) => {
          const ctx = {
            changes: meta.meta.changes ?? 0,
            lastID: meta.meta.last_row_id ?? 0,
          };
          (callback as (this: typeof ctx, err: Error | null) => void).call(ctx, null);
        })
        .catch((e) => callback(e instanceof Error ? e : new Error(String(e))));
    },
    get(sql, params, cb) {
      let p: unknown[] = [];
      let callback: (err: Error | null, row?: Record<string, unknown>) => void;
      if (typeof params === "function") {
        callback = params as (err: Error | null, row?: Record<string, unknown>) => void;
        p = [];
      } else {
        p = params || [];
        callback = cb as (err: Error | null, row?: Record<string, unknown>) => void;
      }
      d1.prepare(sql)
        .bind(...p)
        .first<Record<string, unknown>>()
        .then((row) => callback(null, row ?? undefined))
        .catch((e) => callback(e instanceof Error ? e : new Error(String(e))));
    },
    all(sql, params, cb) {
      let p: unknown[] = [];
      let callback: (err: Error | null, rows?: Record<string, unknown>[]) => void;
      if (typeof params === "function") {
        callback = params as (err: Error | null, rows?: Record<string, unknown>[]) => void;
        p = [];
      } else {
        p = params || [];
        callback = cb as (err: Error | null, rows?: Record<string, unknown>[]) => void;
      }
      d1.prepare(sql)
        .bind(...p)
        .all<Record<string, unknown>>()
        .then((r) => callback(null, r.results ?? []))
        .catch((e) => callback(e instanceof Error ? e : new Error(String(e))));
    },
  };
}
