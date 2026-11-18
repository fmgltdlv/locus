import { AsyncLocalStorage } from "node:async_hooks";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { Env } from "./types.js";

const als = new AsyncLocalStorage<Env>();

/** Copy string Worker bindings into `process.env` for legacy CJS modules (crypto, nGen clients, credential decrypt). */
export function syncEnvToProcess(env: Env) {
  if (typeof process === "undefined" || !process.env) return;
  const e = env as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    const v = e[key];
    if (typeof v === "string") process.env[key] = v;
  }
}

/** Sync env vars then run with AsyncLocalStorage `Env` (HTTP, cron, Workflows). */
export function runWithWorkerContext<T>(env: Env, fn: () => T): T {
  return runWithEnv(env, fn);
}

export function runWithEnv<T>(env: Env, fn: () => T): T {
  syncEnvToProcess(env);
  return als.run(env, fn);
}

export function getEnv(): Env {
  const e = als.getStore();
  if (!e) throw new Error("getEnv() called outside request context");
  return e;
}

/** Workers KV (`APP_KV` binding) when configured; use for app_kv-style keys, operator directory, etc. */
export function getWorkerKv(): KVNamespace | undefined {
  return getEnv().APP_KV;
}
