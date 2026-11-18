'use strict';
/**
 * Ticket Hub UI punctuation as \\u escapes so Windows/editor encoding cannot mangle literals.
 * Use window.TICKET_HUB_TEXT.EM_DASH etc. instead of typing —, ✓, 📷 in source.
 */
const TICKET_HUB_TEXT = {
    EM_DASH: '\u2014',
    EN_DASH: '\u2013',
    MIDDLE_DOT: '\u00B7',
    ELLIPSIS: '\u2026',
    CHECK: '\u2713',
    CROSS: '\u2717',
    CAMERA: '\uD83D\uDCF7',
    ARROW: '\u2192',
    SIDEBAR_TOGGLE: '\u2039',
};
window.TICKET_HUB_TEXT = TICKET_HUB_TEXT;
