/** Must match cloudflare/deploy/src/lib/passwordPolicy.ts */
const PASSWORD_POLICY_MESSAGE =
    'Password must be at least 8 characters and include at least one number and one special character.';

function validatePasswordPolicy(password) {
    const p = String(password ?? '');
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

window.PASSWORD_POLICY_MESSAGE = PASSWORD_POLICY_MESSAGE;
window.validatePasswordPolicy = validatePasswordPolicy;
