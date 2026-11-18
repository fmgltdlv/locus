/**
 * USAN **service** credentials read from Worker env (USAN_SERVICE_* / aliases).
 * Production Worker nGen flows use org master accounts only (`pacPollNgenCredentials.cjs`);
 * these env vars apply only when that module allows global creds (dev/test `APP_ENV`).
 *
 * Admin → USAN webhook rows store `pacweb_username` **only for matching incoming data to an organization**;
 * they are **not** used to log into PAC or nGen.
 */

function getUsanServiceCredentialsFromEnv() {
    const user = (
        process.env.USAN_SERVICE_USERNAME ||
        process.env.NGEN_USER ||
        process.env.USAN_USER ||
        ''
    ).trim();
    const pass =
        process.env.USAN_SERVICE_PASSWORD || process.env.NGEN_PASS || process.env.USAN_PASS || '';
    return { user, pass };
}

/** True when both username and password are non-empty (PAC + nGen pulls may run). */
function hasUsanServiceCredentialsInEnv() {
    const { user, pass } = getUsanServiceCredentialsFromEnv();
    return Boolean(user && pass);
}

module.exports = {
    getUsanServiceCredentialsFromEnv,
    hasUsanServiceCredentialsInEnv,
};
