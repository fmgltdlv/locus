import { safeParseJSON } from "./utils.js";

/** Stored / admin subscription tier values. */
export type SubscriptionTierColumn = "basic" | "enhanced" | "max";

/** Product feature tier: Basic or Enhanced (Max includes Enhanced features). */
export type ProductSubscriptionTier = "basic" | "enhanced";

function normalizeTierToken(raw: unknown): string {
  return raw != null ? String(raw).trim().toLowerCase() : "";
}

/**
 * Normalize a tier string from column or settings.
 * Legacy `plus` → enhanced. Unknown → basic.
 */
export function normalizeSubscriptionTier(
  raw: unknown
): SubscriptionTierColumn {
  const t = normalizeTierToken(raw);
  if (t === "max") return "max";
  if (t === "plus" || t === "enhanced") return "enhanced";
  return "basic";
}

/** True when org gets Enhanced aerial/map features (Enhanced or Max). */
export function hasEnhancedFeatures(tier: unknown): boolean {
  const t = normalizeSubscriptionTier(tier);
  return t === "enhanced" || t === "max";
}

/** True when Max auto feed SR sync should run. */
export function hasMaxFeedAutoSync(tier: unknown): boolean {
  return normalizeSubscriptionTier(tier) === "max";
}

/**
 * Prefer organizations.subscription_tier column; fall back to settings JSON.
 */
export function getSubscriptionTierFromOrgRow(
  row: { subscription_tier?: unknown; settings?: unknown } | null | undefined
): SubscriptionTierColumn {
  if (row && row.subscription_tier != null && String(row.subscription_tier).trim() !== "") {
    return normalizeSubscriptionTier(row.subscription_tier);
  }
  const s = safeParseJSON<Record<string, unknown>>(row?.settings, {}) ?? {};
  return normalizeSubscriptionTier(s.subscriptionTier ?? s.subscription_tier ?? "basic");
}

/**
 * Per-org tier from admin/settings JSON for organization.subscription_tier column.
 * Persists distinct `max` (no longer collapses max → enhanced).
 */
export function getSubscriptionTierColumnFromSettings(
  settingsRaw: string | object | null | undefined
): SubscriptionTierColumn {
  const s = safeParseJSON<Record<string, unknown>>(settingsRaw, {}) ?? {};
  return normalizeSubscriptionTier(s.subscriptionTier ?? s.subscription_tier ?? "basic");
}

/**
 * @deprecated use getSubscriptionTierColumnFromSettings — returns basic|enhanced for legacy callers
 * (max maps to enhanced for feature gates).
 */
export function getSubscriptionTierFromSettings(
  settingsRaw: string | object | null | undefined
): ProductSubscriptionTier {
  return hasEnhancedFeatures(getSubscriptionTierColumnFromSettings(settingsRaw))
    ? "enhanced"
    : "basic";
}
