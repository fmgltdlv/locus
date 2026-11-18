#!/usr/bin/env node
/**
 * Ensures D1 migrations exist only under cloudflare/deploy/migrations/.
 * Allows cloudflare/migrations/README.md as a pointer (no .sql files).
 */
import { readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const legacyDir = join(root, 'cloudflare', 'migrations');
const canonicalDir = join(root, 'cloudflare', 'deploy', 'migrations');

async function listSql(dir) {
  try {
    const names = await readdir(dir);
    return names.filter((n) => n.endsWith('.sql'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

async function legacyHasUnexpectedFiles() {
  try {
    const names = await readdir(legacyDir);
    const allowed = new Set(['README.md']);
    const bad = names.filter((n) => !allowed.has(n));
    return bad;
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

const legacySql = await listSql(legacyDir);
if (legacySql.length) {
  console.error(
    '[check-migrations-path] Remove SQL from cloudflare/migrations/ (deprecated):\n  ' +
      legacySql.map((f) => `cloudflare/migrations/${f}`).join('\n  ')
  );
  console.error('  Add migrations only under cloudflare/deploy/migrations/');
  process.exit(1);
}

const unexpected = await legacyHasUnexpectedFiles();
if (unexpected.length) {
  console.error(
    '[check-migrations-path] Unexpected files under cloudflare/migrations/:\n  ' +
      unexpected.map((f) => `cloudflare/migrations/${f}`).join('\n  ')
  );
  console.error('  Only README.md is allowed there (pointer to deploy/migrations).');
  process.exit(1);
}

try {
  await stat(canonicalDir);
} catch {
  console.error('[check-migrations-path] Missing canonical directory: cloudflare/deploy/migrations/');
  process.exit(1);
}

const canonicalSql = await listSql(canonicalDir);
if (!canonicalSql.length) {
  console.error('[check-migrations-path] No .sql files in cloudflare/deploy/migrations/');
  process.exit(1);
}

console.log(
  `[check-migrations-path] OK — ${canonicalSql.length} migration(s) in cloudflare/deploy/migrations/`
);
