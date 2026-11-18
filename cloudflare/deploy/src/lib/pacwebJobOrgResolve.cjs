/**
 * Map PAC / nGen payloads to an organization using `organization_pacweb_accounts.pacweb_username`
 * (same identifier admins configure for webhooks). A ticket is tied to a customer org when we can
 * match a visible username (PAC job row or nGen EnquirySearch / enquiryDetails) to that account.
 */

/**
 * @param {string} s
 * @returns {string}
 */
function normalizeHint(s) {
    return String(s || '')
        .trim()
        .toLowerCase();
}

/**
 * Collect comparable strings from a PAC `Jobs` row (field names vary by USAN version).
 * @param {object} row
 * @returns {string[]}
 */
function hintsFromPacJobRow(row) {
    if (!row || typeof row !== 'object') return [];
    const explicitKeys = [
        'LodgedByUserName',
        'lodgedByUserName',
        'CustomerUserName',
        'CustomerName',
        'CompanyName',
        'ExcavatorName',
        'SharedByUserName',
        'JobOwnerName',
        'PelicanCompanyName',
        'Email',
        'UserName',
        'emailOrUserName',
    ];
    const hints = new Set();
    for (const k of explicitKeys) {
        if (!(k in row)) continue;
        const v = row[k];
        if (v != null && typeof v !== 'object') {
            const t = String(v).trim();
            if (t) {
                hints.add(normalizeHint(t));
                if (t.includes('@')) {
                    hints.add(normalizeHint(t.split('@')[0]));
                }
            }
        }
    }
    for (const [k, v] of Object.entries(row)) {
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (t.length < 3 || t.length > 240) continue;
        if (!/[a-zA-Z]/.test(t)) continue;
        if (
            /name|user|email|company|customer|excavator|lodged|owner|shared|caller|account/i.test(k) ||
            /mail|email/i.test(k)
        ) {
            hints.add(normalizeHint(t));
            if (t.includes('@')) {
                hints.add(normalizeHint(t.split('@')[0]));
            }
        }
    }
    return [...hints].filter(Boolean);
}

/**
 * Collect comparable strings from an nGen EnquirySearch-style object (top-level and `enquiryDetails`).
 * @param {object} enquiry
 * @returns {string[]}
 */
function hintsFromEnquirySearch(enquiry) {
    if (!enquiry || typeof enquiry !== 'object') return [];
    const merged = new Set(hintsFromPacJobRow(enquiry));
    for (const h of hintsFromPacJobRow(enquiry.enquiryDetails)) merged.add(h);
    const lb = enquiry.enquiryDetails && enquiry.enquiryDetails.lodgedBy;
    if (lb && typeof lb === 'object') {
        for (const h of hintsFromPacJobRow(lb)) merged.add(h);
    }
    return [...merged].filter(Boolean);
}

/**
 * @param {string} accountNorm — normalized pacweb_username
 * @param {string} hintNorm
 * @returns {boolean}
 */
function usernameMatchesHint(accountNorm, hintNorm) {
    if (!accountNorm || !hintNorm) return false;
    if (accountNorm === hintNorm) return true;
    const aLocal = accountNorm.includes('@') ? accountNorm.split('@')[0] : accountNorm;
    const hLocal = hintNorm.includes('@') ? hintNorm.split('@')[0] : hintNorm;
    if (aLocal.length >= 3 && hLocal.length >= 3 && aLocal === hLocal) return true;

    if (accountNorm.length >= 4 && hintNorm.includes(accountNorm)) return true;
    if (hintNorm.length >= 4 && accountNorm.includes(hintNorm)) return true;
    if (aLocal.length >= 4 && hintNorm.includes(aLocal)) return true;
    if (hLocal.length >= 4 && accountNorm.includes(hLocal)) return true;
    return false;
}

/**
 * @param {{ organization_id: number, pacweb_username: string }[]} accounts ordered for stable tie-break
 * @param {string[]} hints normalized hint strings from hintsFromPacJobRow / hintsFromEnquirySearch
 * @returns {number | null} organization_id
 */
function resolveOrganizationIdFromHints(accounts, hints) {
    if (!Array.isArray(accounts) || accounts.length === 0) return null;
    const hintList = Array.isArray(hints) ? hints : [];
    if (!hintList.length) return null;

    for (const acc of accounts) {
        const raw = acc && acc.pacweb_username != null ? String(acc.pacweb_username).trim() : '';
        if (!raw) continue;
        const u = normalizeHint(raw);
        const uHints = [u];
        if (raw.includes('@')) {
            uHints.push(normalizeHint(raw.split('@')[0]));
        }
        for (const un of uHints) {
            for (const h of hintList) {
                if (usernameMatchesHint(un, h)) {
                    return acc.organization_id;
                }
            }
        }
    }
    return null;
}

/**
 * @param {{ organization_id: number, pacweb_username: string }[]} accounts ordered for stable tie-break
 * @param {object} jobRow one element from PAC `Jobs`
 * @returns {number | null} organization_id
 */
function resolveOrganizationIdForPacJobRow(accounts, jobRow) {
    return resolveOrganizationIdFromHints(accounts, hintsFromPacJobRow(jobRow));
}

/**
 * @param {{ organization_id: number, pacweb_username: string }[]} accounts
 * @param {object} enquiry EnquirySearch JSON from nGen
 * @returns {number | null} organization_id
 */
function resolveOrganizationIdForEnquirySearch(accounts, enquiry) {
    return resolveOrganizationIdFromHints(accounts, hintsFromEnquirySearch(enquiry));
}

/**
 * Org ids whose `pacweb_username` matches `enquiryDetails.lodgedByUserName` (routing / duplicate copies).
 * @param {{ organization_id: number, pacweb_username: string }[]} accounts
 * @param {string|undefined|null} lodgedByUserName
 * @returns {number[]}
 */
function findOrganizationIdsForLodgedByUserName(accounts, lodgedByUserName) {
    if (!Array.isArray(accounts) || lodgedByUserName == null) return [];
    const h = normalizeHint(lodgedByUserName);
    if (!h) return [];
    const out = [];
    for (const acc of accounts) {
        const raw = acc && acc.pacweb_username != null ? String(acc.pacweb_username).trim() : '';
        if (!raw) continue;
        const u = normalizeHint(raw);
        const uHints = [u];
        if (raw.includes('@')) {
            uHints.push(normalizeHint(raw.split('@')[0]));
        }
        let hit = false;
        for (const un of uHints) {
            if (usernameMatchesHint(un, h)) {
                hit = true;
                break;
            }
        }
        if (hit && !out.includes(acc.organization_id)) out.push(acc.organization_id);
    }
    return out;
}

module.exports = {
    resolveOrganizationIdFromHints,
    resolveOrganizationIdForPacJobRow,
    resolveOrganizationIdForEnquirySearch,
    findOrganizationIdsForLodgedByUserName,
    hintsFromPacJobRow,
    hintsFromEnquirySearch,
};
