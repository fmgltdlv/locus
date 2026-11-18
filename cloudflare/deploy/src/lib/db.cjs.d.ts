import type { SqliteLike } from "../database.js";

export function runDb(
  db: SqliteLike,
  sql: string,
  params?: unknown[]
): Promise<{ lastID: number; changes: number }>;

export function getRow(
  db: SqliteLike,
  sql: string,
  params?: unknown[]
): Promise<Record<string, unknown> | null>;

export function allRows(
  db: SqliteLike,
  sql: string,
  params?: unknown[]
): Promise<Record<string, unknown>[]>;
