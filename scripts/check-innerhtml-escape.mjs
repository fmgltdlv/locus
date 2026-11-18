#!/usr/bin/env node
/**
 * Flag risky `innerHTML =` assignments in frontend JS that lack nearby HTML escaping.
 * See scripts/check-innerhtml-escape.allowlist.json for reviewed exceptions.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const frontendJs = join(root, "frontend", "js");
const allowlistPath = join(dirname(fileURLToPath(import.meta.url)), "check-innerhtml-escape.allowlist.json");

const ESCAPE_MARKERS = [
  "escapeHtmlText",
  "escapeHtmlAttr",
  "escapeJsStringLiteral",
  "escapeAdminHtml",
  "hubEscapeHtml",
  "escapeTicketNoteHtml",
  "escapeHtmlTicketUi",
  "escapeHtmlForAnnotation",
  "escapeComplianceHubHtml",
  "escapeTicketProjectHtml",
  "analyticsEscapeHtml",
  "escapeHtml(",
  "buildPhotoMapPopupInfoInnerHtml",
  "buildTicketCardHtml",
  "buildTicketViewLogPanelHtml",
  "buildTicketPopupBodyHtml",
  "ticketPopupBodyHtml",
  "utilitySectionsHtml",
  "T.btn(",
  "T.link(",
  "T.iconBtn(",
];

const skippedDirs = new Set(["node_modules", "dist", "photos"]);

function toRepoPath(filePath) {
  return relative(root, filePath).split(sep).join("/");
}

function loadAllowlist() {
  if (!existsSync(allowlistPath)) return new Set();
  const raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return new Set(entries);
}

function isClearAssignment(line) {
  return /innerHTML\s*=\s*(''|""|``)\s*;?\s*$/.test(line.trim());
}

function hasEscapeMarker(text) {
  return ESCAPE_MARKERS.some((m) => text.includes(m));
}

function isLikelySafeStaticLiteral(line) {
  const trimmed = line.trim();
  if (!/innerHTML\s*=/.test(trimmed)) return false;
  if (/\$\{/.test(trimmed)) return false;
  return /innerHTML\s*=\s*['"`][^'"`]*['"`]\s*;?\s*$/.test(trimmed);
}

const writeBaseline = process.argv.includes("--write-baseline");

function walkJsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!skippedDirs.has(name)) walkJsFiles(full, out);
      continue;
    }
    if (!name.endsWith(".js")) continue;
    if (name.endsWith(".bundle.js")) continue;
    out.push(full);
  }
  return out;
}

function statementContext(lines, index) {
  const start = Math.max(0, index - 5);
  let end = index;
  while (end < lines.length && end < index + 20) {
    if (end > index && /;\s*$/.test(lines[end])) break;
    end += 1;
  }
  return lines.slice(start, end + 1).join("\n");
}

function checkFile(filePath, allowlist) {
  const repoPath = toRepoPath(filePath);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\.innerHTML\s*=/.test(line) && !/innerHTML\s*=/.test(line)) continue;

    const key = `${repoPath}:${i + 1}`;
    if (allowlist.has(key)) continue;
    if (isClearAssignment(line)) continue;
    if (isLikelySafeStaticLiteral(line)) continue;

    const context = statementContext(lines, i);
    if (hasEscapeMarker(context)) continue;

    findings.push({ file: repoPath, line: i + 1, text: line.trim() });
  }

  return findings;
}

const allowlist = loadAllowlist();
const files = walkJsFiles(frontendJs);
const allFindings = [];
for (const file of files) {
  allFindings.push(...checkFile(file, new Set()));
}

if (writeBaseline) {
  const entries = [...new Set(allFindings.map((f) => `${f.file}:${f.line}`))].sort();
  const payload = {
    _comment:
      "Pre-existing innerHTML assignments reviewed at Phase 4 baseline. New assignments must use escape helpers or add a line here with justification.",
    entries,
  };
  writeFileSync(allowlistPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[check-innerhtml-escape] Wrote ${entries.length} baseline entries to ${toRepoPath(allowlistPath)}`);
  process.exit(0);
}

const filteredFindings = [];
for (const file of files) {
  filteredFindings.push(...checkFile(file, allowlist));
}

if (filteredFindings.length === 0) {
  console.log("[check-innerhtml-escape] OK — no unreviewed innerHTML assignments.");
  process.exit(0);
}

console.error(`[check-innerhtml-escape] ${filteredFindings.length} unreviewed innerHTML assignment(s):`);
for (const f of filteredFindings.slice(0, 50)) {
  console.error(`  ${f.file}:${f.line}  ${f.text}`);
}
if (filteredFindings.length > 50) {
  console.error(`  ... and ${filteredFindings.length - 50} more`);
}
console.error(
  "\nAdd reviewed lines to scripts/check-innerhtml-escape.allowlist.json or use escape helpers nearby."
);
process.exit(1);
