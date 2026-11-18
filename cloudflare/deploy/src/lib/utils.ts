export function safeParseJSON<T = Record<string, unknown>>(raw: unknown, defaultVal: T | null = null): T | null {
  if (raw == null) return defaultVal;
  try {
    let parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed && typeof parsed === "object" ? (parsed as T) : defaultVal;
  } catch {
    return defaultVal;
  }
}
