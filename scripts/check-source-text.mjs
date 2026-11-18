#!/usr/bin/env node
/**
 * Enforce valid source text for executable/config files.
 *
 * Intentional UTF-8 glyphs are allowed. Corrupted replacement characters,
 * mojibake, and suspicious question-mark UI text are blocked.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FINDINGS = 100;

const checkedExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.sql',
  '.toml',
  '.ts',
]);

const skippedDirs = new Set([
  '.git',
  '.wrangler',
  'coverage',
  'dist',
  'docs',
  'fixeddb',
  'node_modules',
]);

const skippedFileNames = new Set([
  'package-lock.json',
]);

const skippedExtensions = new Set([
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.lock',
  '.md',
  '.pdf',
  '.png',
  '.svg',
  '.webp',
]);

const mojibakeFragments = [
  '\u00e2\u20ac\u0153',
  '\u00e2\u20ac\ufffd',
  '\u00e2\u20ac\u02dc',
  '\u00e2\u20ac\u2122',
  '\u00e2\u20ac\u201c',
  '\u00e2\u20ac\u201d',
  '\u00e2\u20ac\u00a6',
  '\u00e2\u0153',
  '\u00f0\u0178',
];

function toRepoPath(filePath) {
  return relative(root, filePath).split(sep).join('/');
}

function extensionOf(repoPath) {
  const idx = repoPath.lastIndexOf('.');
  return idx === -1 ? '' : repoPath.slice(idx).toLowerCase();
}

function shouldSkipRepoPath(repoPath) {
  const parts = repoPath.split('/');
  if (parts.some((part) => skippedDirs.has(part))) return true;
  if (skippedFileNames.has(parts[parts.length - 1])) return true;
  if (repoPath.endsWith('.bundle.js')) return true;
  if (repoPath.includes('/dist/') || repoPath.includes('/im/')) return true;
  return skippedExtensions.has(extensionOf(repoPath));
}

function shouldCheckRepoPath(repoPath) {
  if (shouldSkipRepoPath(repoPath)) return false;
  return checkedExtensions.has(extensionOf(repoPath));
}

function listGitFiles() {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8' }
    );
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const repoPath = toRepoPath(fullPath);
    if (entry.isDirectory()) {
      if (!shouldSkipRepoPath(repoPath)) walk(fullPath, out);
    } else {
      out.push(repoPath);
    }
  }
  return out;
}

function listFiles() {
  const gitFiles = listGitFiles();
  const files = gitFiles.length ? gitFiles : walk(root);
  return files.filter((repoPath) => {
    const fullPath = join(root, ...repoPath.split('/'));
    return shouldCheckRepoPath(repoPath) && existsSync(fullPath) && statSync(fullPath).isFile();
  });
}

function columnOf(line, index) {
  return [...line.slice(0, index)].length + 1;
}

function addFinding(findings, repoPath, lineNumber, column, message, sample) {
  if (findings.length >= MAX_FINDINGS) return;
  findings.push({ repoPath, lineNumber, column, message, sample });
}

function scanFile(repoPath, findings) {
  const fullPath = join(root, ...repoPath.split('/'));
  const text = readFileSync(fullPath, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    if (line.includes('\uFFFD')) {
      addFinding(
        findings,
        repoPath,
        lineIdx + 1,
        columnOf(line, line.indexOf('\uFFFD')),
        'Replacement character U+FFFD',
        line.trim().slice(0, 160)
      );
    }

    const suspiciousPatterns = [
      /(['"`])\?\?\1/,
      />\?\?</,
      /\blog\((['"`])\?\?/,
      /\btextContent\s*=\s*(['"`])\?\?/,
    ];
    for (const pattern of suspiciousPatterns) {
      const match = line.match(pattern);
      if (match && match.index != null) {
        addFinding(
          findings,
          repoPath,
          lineIdx + 1,
          columnOf(line, match.index),
          'Suspicious question-mark UI text',
          line.trim().slice(0, 160)
        );
      }
    }

    for (const fragment of mojibakeFragments) {
      const idx = line.indexOf(fragment);
      if (idx !== -1) {
        addFinding(
          findings,
          repoPath,
          lineIdx + 1,
          columnOf(line, idx),
          `Mojibake fragment ${JSON.stringify(fragment)}`,
          line.trim().slice(0, 160)
        );
      }
    }
  }
}

const findings = [];
for (const repoPath of listFiles()) {
  scanFile(repoPath, findings);
}

if (findings.length) {
  console.error('[check-source-text] Source text policy failed.');
  console.error('Fix corrupted text, mojibake, replacement characters, or accidental double-question-mark UI text.');
  for (const f of findings) {
    console.error(`\n${f.repoPath}:${f.lineNumber}:${f.column} ${f.message}`);
    if (f.sample) console.error(`  ${f.sample}`);
  }
  if (findings.length >= MAX_FINDINGS) {
    console.error(`\nShowing first ${MAX_FINDINGS} finding(s). Fix these and rerun.`);
  }
  process.exit(1);
}

console.log('[check-source-text] OK - source text has no known corruption markers.');
