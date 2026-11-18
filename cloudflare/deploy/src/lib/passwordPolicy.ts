export const PASSWORD_POLICY_MESSAGE =
  "Password must be at least 8 characters and include at least one number and one special character.";

export function validatePasswordPolicy(
  password: string
): { ok: true } | { ok: false; error: string } {
  const p = String(password ?? "");
  if (p.length < 8) {
    return { ok: false, error: PASSWORD_POLICY_MESSAGE };
  }
  if (!/\d/.test(p)) {
    return { ok: false, error: PASSWORD_POLICY_MESSAGE };
  }
  if (!/[^A-Za-z0-9]/.test(p)) {
    return { ok: false, error: PASSWORD_POLICY_MESSAGE };
  }
  return { ok: true };
}
