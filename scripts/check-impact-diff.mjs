#!/usr/bin/env node
/**
 * Diff-aware blast-radius checklist.
 *
 * Reads git changed paths, matches them against scripts/impact-matrix.json,
 * and prints sibling routes / checks / smokes that must be re-verified.
 *
 * Usage:
 *   npm run impact:diff
 *   node scripts/check-impact-diff.mjs [--base <ref>] [--staged] [--fail-on-high]
 *
 * Exit codes:
 *   0 — printed OK (or no matrix hits)
 *   1 — --fail-on-high and at least one high-risk path changed
 *   2 — matrix missing / git failure
 */
import { readFileSync } from 'node:fs';
import { join, dirname, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = join(root, 'scripts', 'impact-matrix.json');

function parseArgs(argv) {
  const out = { base: null, staged: false, failOnHigh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--staged') out.staged = true;
    else if (a === '--fail-on-high') out.failOnHigh = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function normPath(p) {
  return normalize(p).split('\\').join('/');
}

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
}

function resolveBase(explicit) {
  if (explicit) return explicit;
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      git(`git rev-parse --verify ${candidate}`);
      return git(`git merge-base HEAD ${candidate}`);
    } catch {
      /* try next */
    }
  }
  return null;
}

function listChangedFiles({ base, staged }) {
  const files = new Set();
  const addLines = (text) => {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t) files.add(normPath(t));
    }
  };

  try {
    if (staged) {
      addLines(git('git diff --name-only --cached'));
    } else {
      addLines(git('git diff --name-only'));
      addLines(git('git diff --name-only --cached'));
      try {
        addLines(git('git ls-files --others --exclude-standard'));
      } catch {
        /* ignore */
      }
      if (base) {
        addLines(git(`git diff --name-only ${base}...HEAD`));
      }
    }
  } catch (e) {
    console.error('[impact:diff] git failed:', e.message || e);
    process.exit(2);
  }
  return [...files];
}

function pathMatches(changed, entryPath) {
  const ep = normPath(entryPath).replace(/\/$/, '');
  if (ep.endsWith('/')) {
    return changed === ep.slice(0, -1) || changed.startsWith(ep);
  }
  if (changed === ep) return true;
  // Directory prefix entries (migrations/)
  if (ep.endsWith('/')) return changed.startsWith(ep);
  if (entryPath.endsWith('/')) return changed.startsWith(normPath(entryPath));
  return changed.startsWith(ep + '/');
}

function loadMatrix() {
  try {
    return JSON.parse(readFileSync(matrixPath, 'utf8'));
  } catch (e) {
    console.error('[impact:diff] Cannot read', relative(root, matrixPath), e.message || e);
    process.exit(2);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: node scripts/check-impact-diff.mjs [--base <ref>] [--staged] [--fail-on-high]
Prints sibling blast-radius checklist for changed files.`);
  process.exit(0);
}

const matrix = loadMatrix();
const base = resolveBase(args.base);
const changed = listChangedFiles({ base, staged: args.staged });

const hits = [];
for (const entry of matrix.entries || []) {
  const matchedPaths = (entry.paths || []).filter((p) =>
    changed.some((c) => pathMatches(c, p))
  );
  if (matchedPaths.length) {
    hits.push({ entry, matchedPaths });
  }
}

console.log('[impact:diff] Changed files considered:', changed.length);
if (base) console.log('[impact:diff] Base:', base);
else console.log('[impact:diff] Base: (working tree only — no main merge-base)');

if (!hits.length) {
  console.log('[impact:diff] No high/medium matrix paths in the diff.');
  process.exit(0);
}

let highCount = 0;
console.log('');
console.log('## Blast-radius checklist (from impact-matrix.json)');
console.log('');

for (const { entry, matchedPaths } of hits) {
  if (entry.risk === 'high') highCount++;
  console.log(`### [${entry.risk || '?'}] ${entry.id}`);
  console.log(`Matched: ${matchedPaths.join(', ')}`);
  if (entry.notes) console.log(`Notes: ${entry.notes}`);
  console.log('Siblings to re-verify:');
  for (const s of entry.siblings || []) console.log(`  - [ ] ${s}`);
  if (entry.checks?.length) {
    console.log('Checks:');
    for (const c of entry.checks) console.log(`  - [ ] ${c}`);
  }
  if (entry.smokes?.length) {
    console.log('Smokes:');
    for (const s of entry.smokes) console.log(`  - [ ] ${s}`);
  }
  console.log('');
}

console.log(
  `[impact:diff] ${hits.length} matrix entr${hits.length === 1 ? 'y' : 'ies'} hit` +
    (highCount ? ` (${highCount} high-risk)` : '') +
    '.'
);
console.log(
  'Agents: mark each sibling exercised or not-exercised in the cascade-impact summary before done.'
);

if (args.failOnHigh && highCount > 0) {
  console.error('[impact:diff] Failing because --fail-on-high and high-risk paths changed.');
  process.exit(1);
}

process.exit(0);
