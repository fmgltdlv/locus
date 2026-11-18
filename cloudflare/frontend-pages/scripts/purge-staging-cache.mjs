#!/usr/bin/env node
/**
 * Purge Cloudflare edge cache for staging static assets after a Pages deploy.
 * Prevents stale /im/* entries (e.g. HTML cached as CSS) on the staging host.
 *
 * Auth: CLOUDFLARE_API_TOKEN, or oauth_token from `npx wrangler login`.
 * Optional: CLOUDFLARE_ZONE_ID (skips zone lookup).
 * Set CLOUDFLARE_ZONE_NAME and PAGES_HOST for your domain.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME || 'example.com';
const STAGING_HOST = process.env.PAGES_HOST || 'staging.example.com';
const PURGE_PREFIXES = [
  `${STAGING_HOST}/im/`,
  `${STAGING_HOST}/manifest.webmanifest`,
  `${STAGING_HOST}/sw.js`,
  `${STAGING_HOST}/index.html`,
  `${STAGING_HOST}/js/config.js`,
  `${STAGING_HOST}/js/config-override.js`,
  `${STAGING_HOST}/js/pwa-register.js`,
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
  const data = await res.json();
  if (!res.ok || !data.success) {
    const msg =
      data.errors?.map((e) => e.message).join('; ') ||
      data.messages?.join('; ') ||
      res.statusText;
    throw new Error(msg || 'Cloudflare API request failed');
  }
  return data;
}

async function resolveZoneId(token) {
  if (process.env.CLOUDFLARE_ZONE_ID) return process.env.CLOUDFLARE_ZONE_ID;
  const data = await cfApi(token, `/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  const zone = data.result?.[0];
  if (!zone?.id) throw new Error(`Zone not found: ${ZONE_NAME}`);
  return zone.id;
}

async function main() {
  const token = readAuthToken();
  if (!token) {
    console.warn(
      '[purge-staging-cache] Skipped: no CLOUDFLARE_API_TOKEN and no wrangler oauth_token. Run `npx wrangler login` or set CLOUDFLARE_API_TOKEN with Cache Purge permission.'
    );
    process.exit(0);
  }

  const zoneId = await resolveZoneId(token);
  await cfApi(token, `/zones/${zoneId}/purge_cache`, {
    method: 'POST',
    body: JSON.stringify({ prefixes: PURGE_PREFIXES }),
  });
  console.log(`[purge-staging-cache] Purged ${PURGE_PREFIXES.length} prefix(es) on ${ZONE_NAME} (${STAGING_HOST}).`);
}

main().catch((err) => {
  console.warn(`[purge-staging-cache] Warning: ${err.message || err}`);
  console.warn('[purge-staging-cache] Deploy succeeded; purge manually in Cloudflare → Caching → Purge Cache if staging looks stale.');
  process.exit(0);
});
