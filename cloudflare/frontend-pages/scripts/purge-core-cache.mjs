#!/usr/bin/env node
/**
 * Purge Cloudflare edge cache for Core static assets after a Pages deploy.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME || 'example.com';
const CORE_HOST = process.env.PAGES_HOST || 'app.example.com';
const PURGE_PREFIXES = [
  `${CORE_HOST}/im/`,
  `${CORE_HOST}/manifest.webmanifest`,
  `${CORE_HOST}/sw.js`,
  `${CORE_HOST}/index.html`,
  `${CORE_HOST}/js/config.js`,
  `${CORE_HOST}/js/config-override.js`,
  `${CORE_HOST}/js/pwa-register.js`,
];

function wranglerConfigPaths() {
  const home = homedir();
  return [
    join(home, '.wrangler', 'config', 'default.toml'),
    join(home, 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml'),
  ];
}

function readAuthToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  for (const path of wranglerConfigPaths()) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const oauth = text.match(/^oauth_token\s*=\s*"([^"]+)"/m);
    if (oauth?.[1]) return oauth[1];
    const api = text.match(/^api_token\s*=\s*"([^"]+)"/m);
    if (api?.[1]) return api[1];
  }
  return null;
}

async function cfApi(token, path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Cloudflare API ${path}: ${JSON.stringify(body.errors || body)}`);
  }
  return body;
}

async function main() {
  const token = readAuthToken();
  if (!token) {
    console.warn('[purge-core-cache] No CLOUDFLARE_API_TOKEN or wrangler oauth_token — skip purge.');
    return;
  }
  const zoneId =
    process.env.CLOUDFLARE_ZONE_ID ||
    (await cfApi(token, `/zones?name=${ZONE_NAME}`)).result?.[0]?.id;
  if (!zoneId) throw new Error(`Zone not found: ${ZONE_NAME}`);
  await cfApi(token, `/zones/${zoneId}/purge_cache`, {
    method: 'POST',
    body: JSON.stringify({ prefixes: PURGE_PREFIXES }),
  });
  console.log(`[purge-core-cache] Purged ${PURGE_PREFIXES.length} prefixes on ${CORE_HOST}`);
}

main().catch((err) => {
  console.warn('[purge-core-cache]', err instanceof Error ? err.message : err);
  process.exit(0);
});