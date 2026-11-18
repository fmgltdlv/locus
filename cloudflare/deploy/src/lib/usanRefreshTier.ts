import { getCooperativeLockMs } from "./timeouts.cjs";

/**
 * @param {string|null|undefined} iso
 * @param {number} [nowMs]
 * @param {number} [lockMs]
 */
export function isTimestampWithinCooperativeLock(iso, nowMs = Date.now(), lockMs = getCooperativeLockMs()) {
  if (iso == null || String(iso).trim() === "") return false;
  const ts = Date.parse(String(iso).trim());
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts < lockMs;
}

/**
 * Pure tier-B gate (org freshness is evaluated separately).
 * @param {{
 *   isLiteRefresh: boolean,
 *   forceRefresh: boolean,
 *   isDeep: boolean,
 *   orgListFresh: boolean,
 *   hasJobNumber: boolean,
 *   isSearchStub: boolean,
 * }} input
 * @returns {{ skip: boolean, reason: string|null }}
 */
export function evaluateSkipRevisionFollowForLiteRefresh(input) {
  const {
    isLiteRefresh,
    forceRefresh,
    isDeep,
    orgListFresh,
    hasJobNumber,
    isSearchStub,
  } = input;

  if (!isLiteRefresh) return { skip: false, reason: "not_lite_refresh" };
  if (forceRefresh) return { skip: false, reason: "force_refresh" };
  if (isDeep) return { skip: false, reason: "deep_refresh" };
  if (!orgListFresh) return { skip: false, reason: "org_list_stale" };
  if (!hasJobNumber) return { skip: false, reason: "no_job_number" };
  if (isSearchStub) return { skip: false, reason: "search_stub" };
  return { skip: true, reason: "org_list_fresh" };
}

function revisionSuffixOfRequestNumber(rn) {
  const s = String(rn || "");
  const suffix = s.includes("-") ? parseInt(s.split("-").pop(), 10) : 0;
  return Number.isFinite(suffix) ? suffix : 0;
}

/**
 * Collapse search list items to the highest revision per base (parity with usan-poll import).
 * @param {object[]} searchItems
 * @returns {Map<string, { rn: string, searchItem: object }>}
 */
export function collapseLatestRevisionPerBaseFromSearchItems(searchItems) {
  const latestRnByBase = new Map();
  const requestNumberToSearchItem = new Map();
  for (const item of searchItems || []) {
    const ed = item && (item.enquiryDetails || item.EnquiryDetails);
    const rnRaw = ed && (ed.requestNumber ?? ed.RequestNumber);
    const rn = rnRaw != null ? String(rnRaw).trim() : "";
    if (!rn) continue;
    requestNumberToSearchItem.set(rn, item);
    const base = String(rn).split("-")[0];
    const rev = revisionSuffixOfRequestNumber(rn);
    const prev = latestRnByBase.get(base);
    if (!prev || rev > prev.rev) latestRnByBase.set(base, { rn, rev });
  }
  const out = new Map();
  for (const [base, keep] of latestRnByBase) {
    const searchItem = requestNumberToSearchItem.get(keep.rn);
    if (searchItem) out.set(base, { rn: keep.rn, searchItem });
  }
  return out;
}
