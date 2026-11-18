/** Free / public email domains — classification for signup rules (not a hard ban). */
const FREE_EMAIL_DOMAINS = new Set(
  [
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "yahoo.com",
    "ymail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "gmx.com",
    "gmx.net",
    "mail.com",
    "zoho.com",
    "yandex.com",
    "yandex.ru",
    "qq.com",
    "163.com",
    "126.com",
  ].map((d) => d.toLowerCase())
);

export function normalizeEmail(email: string): string {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function emailDomain(email: string): string {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  if (at < 0 || at === e.length - 1) return "";
  return e.slice(at + 1);
}

export function normalizeEmailDomain(domain: string): string {
  return String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

export function isPublicEmailDomain(domainOrEmail: string): boolean {
  const raw = String(domainOrEmail || "").trim().toLowerCase();
  const domain = raw.includes("@") ? emailDomain(raw) : normalizeEmailDomain(raw);
  if (!domain) return false;
  return FREE_EMAIL_DOMAINS.has(domain);
}

export function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

/** Display name kept as typed; normalized = lowercase, strip spaces, letters+digits only. */
export function normalizeOrgName(displayName: string): string {
  return String(displayName || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function validateOrgDisplayName(displayName: string): { ok: true; name: string; normalized: string } | { ok: false; error: string } {
  const name = String(displayName || "").trim();
  if (!name) return { ok: false, error: "Organization name is required" };
  if (/[^a-zA-Z0-9\s]/.test(name)) {
    return { ok: false, error: "Organization name may only contain letters, numbers, and spaces" };
  }
  const normalized = normalizeOrgName(name);
  if (!normalized) {
    return { ok: false, error: "Organization name must include at least one letter or number" };
  }
  return { ok: true, name, normalized };
}

export function parseEmailList(raw: unknown, max?: number): string[] {
  const list: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    const e = normalizeEmail(v);
    if (!e || !isLikelyEmail(e) || seen.has(e)) return;
    seen.add(e);
    list.push(e);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) push(String(item || ""));
  } else if (typeof raw === "string") {
    for (const part of raw.split(/[\n,;]+/)) push(part);
  }
  if (max != null && Number.isFinite(max) && max >= 0) return list.slice(0, max);
  return list;
}
