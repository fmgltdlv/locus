/**
 * tickets-popup.js — split from tickets-popup-assignees.js (Phase F2).
 * Ticket map popup: show, responses, patch, resize, mobile height.
 * Globals: same window/function names as before (IIFE bundle).
 */
function formatDate(dateString) {
    if (!dateString) return window.TICKET_HUB_TEXT.EM_DASH;
    return window.formatRecordedDateTime(dateString, window.TICKET_HUB_TEXT.EM_DASH, dateString);
}

/**
 * Plain-text operator comments for map popup (portal + provider history notes).
 * @param {object} ticket
 * @param {object} response
 * @returns {string|null}
 */
function getOperatorResponseCommentSupplementForPopup(ticket, response) {
    if (typeof window.formatOperatorResponseCommentsPlain === 'function') {
        return window.formatOperatorResponseCommentsPlain(ticket, response);
    }
    if (!response) return null;
    const cd =
        response.codeDescription != null && String(response.codeDescription).trim() !== ''
            ? String(response.codeDescription).trim()
            : null;
    const cm =
        response.comment != null && String(response.comment).trim() !== ''
            ? String(response.comment).trim()
            : null;
    if (cd && cm && cm !== cd) return cm;
    return null;
}

/**
 * Wire operator-response card actions on the map ticket popup.
 * Card and status glyph both open the status modal (same as mobile).
 */
function wireTicketPopupOperatorResponseActions(ticketRef) {
    const content = document.getElementById('ticketPopupContent');
    if (!content || !ticketRef) return;

    function openStatusForIndex(idx) {
        if (Number.isNaN(idx)) return;
        const tickets = window.ORG_TICKETS || [];
        const t = tickets.find(x => ticketIdEquals(x.id, ticketRef.id));
        if (!t) return;
        if (typeof window.openOperatorResponseStatusModal === 'function') {
            window.openOperatorResponseStatusModal(t, idx);
        }
    }

    content.querySelectorAll('.ticket-popup-op-status-btn').forEach(btn => {
        btn.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            openStatusForIndex(parseInt(btn.getAttribute('data-resp-index'), 10));
        };
    });

    content.querySelectorAll('.ticket-popup-op-status-row').forEach(row => {
        const openStatus = function (e) {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            openStatusForIndex(parseInt(row.getAttribute('data-resp-index'), 10));
        };
        row.onclick = openStatus;
        row.onkeydown = function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            openStatus(e);
        };
    });
}

function wireTicketPopupTicketActions(ticketRef) {
    const content = document.getElementById('ticketPopupContent');
    if (!content || !ticketRef) return;

    const ticketId = ticketRef.id;
    const ticketNumber = ticketRef.ticketNumber;

    content.querySelectorAll('.ticket-popup-photo-view-btn').forEach(btn => {
        btn.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            showTicketPhotos(ticketId, ticketNumber);
        };
    });

    content.querySelectorAll('.ticket-popup-events-btn').forEach(btn => {
        btn.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            openDataWindowForTicket(ticketId, ticketNumber);
        };
    });
}

const TICKET_POPUP_VIEWPORT_LOCK_SEL = '.ticket-popup-viewport-refresh-lock';

/** Stop clicks/touches inside the fixed sheet from bubbling to document-level handlers. */
let ticketPopupDomSurfaceShieldWired = false;
function ensureTicketPopupDomSurfaceShield() {
    if (ticketPopupDomSurfaceShieldWired) return;
    const popup = document.getElementById('ticketPopup');
    if (!popup) return;
    ticketPopupDomSurfaceShieldWired = true;
    const stopBubble = function (e) {
        e.stopPropagation();
    };
    popup.addEventListener('click', stopBubble, false);
    popup.addEventListener('touchend', stopBubble, { passive: true });
    popup.addEventListener(
        'click',
        function (e) {
            const btn =
                e.target && typeof e.target.closest === 'function'
                    ? e.target.closest('.ticket-popup-workflow-status-badge-btn')
                    : null;
            if (!btn || !popup.contains(btn)) return;
            if (!window.workflowAckModule || typeof window.workflowAckModule.openWorkflowAckModal !== 'function') {
                return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            const idKey = popup.getAttribute('data-popup-ticket-id');
            if (!idKey) return;
            const ticket = (window.ORG_TICKETS || []).find((t) => ticketIdEquals(t.id, idKey));
            if (ticket) {
                void window.workflowAckModule.openWorkflowAckModal(ticket);
            }
        },
        true
    );
}

/** In-flight POST /tickets/refresh (lite or stub hydrate) per ticket number - drives header spinner only for the open popup. */
const ticketPopupDetailRefreshDepthByTn = new Map();

function notifyTicketPopupDetailRefreshPending(ticketNumber, delta) {
    const key = ticketNumber != null ? String(ticketNumber).trim() : '';
    if (!key) return;
    const cur = ticketPopupDetailRefreshDepthByTn.get(key) || 0;
    const next = cur + delta;
    if (next <= 0) ticketPopupDetailRefreshDepthByTn.delete(key);
    else ticketPopupDetailRefreshDepthByTn.set(key, next);
    syncTicketPopupHeaderUpdatingIndicator();
}

function syncTicketPopupHeaderUpdatingIndicator() {
    const wrap = document.getElementById('ticketPopupTitleUpdating');
    if (!wrap) return;
    const popup = document.getElementById('ticketPopup');
    const vid = popup && popup.getAttribute('data-popup-ticket-id');
    if (!vid) {
        wrap.hidden = true;
        wrap.setAttribute('aria-hidden', 'true');
        return;
    }
    const list = window.ORG_TICKETS || [];
    const cur = list.find((x) => ticketIdEquals(x.id, vid));
    const tn = cur && cur.ticketNumber != null ? String(cur.ticketNumber).trim() : '';
    const depth = tn ? ticketPopupDetailRefreshDepthByTn.get(tn) || 0 : 0;
    const busy = depth > 0;
    wrap.hidden = !busy;
    wrap.setAttribute('aria-hidden', busy ? 'false' : 'true');
}

function isTicketPopupDetailRefreshPending(ticketNumber) {
    const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
    if (!tn) return false;
    return (ticketPopupDetailRefreshDepthByTn.get(tn) || 0) > 0;
}

window.notifyTicketPopupDetailRefreshPending = notifyTicketPopupDetailRefreshPending;
window.syncTicketPopupHeaderUpdatingIndicator = syncTicketPopupHeaderUpdatingIndicator;
window.isTicketPopupDetailRefreshPending = isTicketPopupDetailRefreshPending;

// Open the shared Ticket history window (utility response timeline + full history PDF)
// from the map ticket popup. History data loads inside the modal when needed.
function openTicketResponseHistoryFromPopup(ticketNumber, _triggerEl) {
    const tn = ticketNumber != null ? String(ticketNumber).trim() : '';
    if (!tn || typeof window.openTicketHistoryModal !== 'function') return;
    const list = window.ORG_TICKETS || [];
    const ticket =
        list.find((t) => t && t.ticketNumber != null && String(t.ticketNumber).trim() === tn) || { ticketNumber: tn };
    window.openTicketHistoryModal(ticket);
}

window.openTicketResponseHistoryFromPopup = openTicketResponseHistoryFromPopup;

function removeTicketPopupViewportRefreshLock(popup) {
    if (!popup) return;
    popup.querySelectorAll(TICKET_POPUP_VIEWPORT_LOCK_SEL).forEach((el) => el.remove());
}

/** Full-panel overlay (centered in the ticket popup), same on mobile and desktop. */
function syncTicketPopupViewportRefreshLock(popup, refreshBusy) {
    if (!popup) return;
    const existing = popup.querySelector(TICKET_POPUP_VIEWPORT_LOCK_SEL);
    if (refreshBusy) {
        if (existing) return;
        const layer = document.createElement('div');
        layer.className = 'ticket-popup-viewport-refresh-lock';
        layer.setAttribute('aria-busy', 'true');
        layer.setAttribute('aria-live', 'polite');
        layer.innerHTML =
            '<div class="ticket-popup-refresh-inner">' +
            (typeof window.getAppLoaderHtml === 'function' ? window.getAppLoaderHtml() : '<div class="app-loading-indicator" role="status" aria-label="Loading"></div>') +
            '<p class="ticket-hub-loading-text">Refreshing ticket...</p>' +
            '</div>';
        popup.appendChild(layer);
        return;
    }
    if (existing) existing.remove();
}

/**
 * Updates only the refresh lockout layer for whatever ticket the popup is bound to
 * (`data-popup-ticket-id`), without requiring `.show` yet (that class is added 50ms after render).
 */
function syncTicketPopupRefreshLockForDisplayedTicket() {
    const popup = document.getElementById('ticketPopup');
    if (!popup) return;
    const vid = popup.getAttribute('data-popup-ticket-id');
    if (!vid) return;
    const list = window.ORG_TICKETS || [];
    const cur = list.find((x) => ticketIdEquals(x.id, vid));
    if (!cur) return;
    const busy =
        typeof ticketSelectionRefreshLoading === 'function' && ticketSelectionRefreshLoading(cur);
    popup.classList.toggle('ticket-popup--refresh-busy', busy);
    syncTicketPopupViewportRefreshLock(popup, busy);
}

window.syncTicketPopupRefreshLockForDisplayedTicket = syncTicketPopupRefreshLockForDisplayedTicket;

function closeTicketPopupMockPreviewModal() {
    const el = document.getElementById('ticketPopupMockPreviewModal');
    if (el) el.remove();
}

/**
 * Single-ticket mock remark preview only (Renew uses renewalUxMockFlow). No Worker.
 * @param {'remark'} mode
 * @param {object} ticket
 */
function openTicketPopupMockPreviewModal(mode, ticket) {
    if (mode !== 'remark') return;
    closeTicketPopupMockPreviewModal();
    if (!ticket) return;
    const tnLabel =
        ticket.ticketNumber != null && String(ticket.ticketNumber).trim() !== ''
            ? String(ticket.ticketNumber).trim()
            : String(ticket.id);
    const titleEsc = escapeHtmlTicketUi('Preview remark (mock)');
    const ticketLineEsc = escapeHtmlTicketUi(tnLabel);

    const remarkFields = `<div class="ticket-hub-mock-field">
                <label class="ticket-hub-mock-label" for="ticketPopupMockModalRemarkText">Shared remark</label>
                <textarea class="ticket-hub-mock-textarea" id="ticketPopupMockModalRemarkText" rows="3" placeholder="Same text would be sent in a real flow"></textarea>
            </div>
            <div class="ticket-hub-mock-field">
                <label class="ticket-hub-mock-label" for="ticketPopupMockModalRemarkVis">Visibility (preview)</label>
                <select class="ticket-hub-mock-input" id="ticketPopupMockModalRemarkVis">
                    <option value="internal">Internal org only</option>
                    <option value="operators">Include operator-facing note</option>
                </select>
            </div>`;

    const wrap = document.createElement('div');
    wrap.id = 'ticketPopupMockPreviewModal';
    wrap.className = 'ticket-hub-mock-modal-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Preview remark');
    wrap.innerHTML = `
        <div class="ticket-hub-mock-panel">
            <div class="ticket-hub-mock-header">
                <h3 class="ticket-hub-mock-title">${titleEsc}</h3>
                <button type="button" class="ticket-hub-mock-close" aria-label="Close">&times;</button>
            </div>
            <p class="ticket-hub-mock-hint">Ticket <strong>${ticketLineEsc}</strong>. Design preview - nothing is sent to a server in this build.</p>
            ${remarkFields}
            <div class="ticket-hub-mock-footer">
                <button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-secondary" data-ticket-popup-mock-dismiss>Cancel</button>
                <button type="button" class="ticket-hub-mock-btn ticket-hub-mock-btn-primary" data-ticket-popup-mock-submit>Preview: submit</button>
            </div>
        </div>`;

    const close = () => closeTicketPopupMockPreviewModal();
    wrap.addEventListener('click', function (ev) {
        if (ev.target === wrap) close();
    });
    const panel = wrap.querySelector('.ticket-hub-mock-panel');
    if (panel) {
        panel.addEventListener('click', function (e) {
            e.stopPropagation();
        });
    }
    const closeBtn = wrap.querySelector('.ticket-hub-mock-close');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const dismissBtn = wrap.querySelector('[data-ticket-popup-mock-dismiss]');
    if (dismissBtn) dismissBtn.addEventListener('click', close);
    const submitBtn = wrap.querySelector('[data-ticket-popup-mock-submit]');
    if (submitBtn) {
        submitBtn.addEventListener('click', function () {
            const lines = [`Remark preview for ticket ${tnLabel}`];
            const tx = document.getElementById('ticketPopupMockModalRemarkText');
            const v = document.getElementById('ticketPopupMockModalRemarkVis');
            if (tx && String(tx.value).trim() !== '') lines.push(`Remark: ${String(tx.value).trim()}`);
            if (v) lines.push(`Visibility: ${v.value}`);
            if (typeof window.appAlert === 'function') void window.appAlert(lines.join('\n'));
            close();
        });
    }
    document.body.appendChild(wrap);
}

function ticketPopupPlaceLine(ticket) {
    if (!ticket) return '';
    const addr = String(
        (window.ticketHubDisplayMap && typeof window.ticketHubDisplayMap.pickTicketField === 'function'
            ? window.ticketHubDisplayMap.pickTicketField(ticket, 'digSiteAddress')
            : null) ||
            ticket.address ||
            ticket.locationSummary ||
            ''
    ).trim();
    const job =
        typeof getTicketJobNameDisplayValue === 'function' ? getTicketJobNameDisplayValue(ticket) : ticket.jobName;
    const jobDisp = job != null && String(job).trim() !== '' ? String(job).trim() : '';
    return [addr, jobDisp].filter(Boolean).join(' · ');
}

function setTicketPopupIdentity(ticket) {
    const title = document.getElementById('ticketPopupTitle');
    const subtitle = document.getElementById('ticketPopupSubtitle');
    if (title) {
        const full = ticketPopupTitleNumberText(ticket);
        const dash = full.lastIndexOf('-');
        const base = dash > 0 ? full.slice(0, dash) : full;
        const rev = dash > 0 ? full.slice(dash + 1) : '';
        const baseHtml = `<span class="ticket-hub-tn-base">${escapeHtmlTicketUi(base)}</span>`;
        const revHtml = rev
            ? `<span class="ticket-hub-tn-rev">-${escapeHtmlTicketUi(rev)}</span>`
            : '';
        title.innerHTML = baseHtml + revHtml;
    }
    if (subtitle) {
        const line = ticketPopupPlaceLine(ticket);
        subtitle.textContent = line;
        subtitle.hidden = !line;
    }
}

/**
 * Ticket # for popup header: same rules as sidebar cards (base + resolved revision when present).
 * @param {object} ticket
 * @returns {string}
 */
function ticketPopupTitleNumberText(ticket) {
    if (!ticket) return '';
    const mod = window.ticketImporterModule;
    const parseParts =
        mod && typeof mod.parseTicketNumberParts === 'function'
            ? mod.parseTicketNumberParts
            : function (t) {
                  const raw = String((t && t.ticketNumber) || '').trim();
                  const idx = raw.indexOf('-');
                  if (idx === -1) return { baseNumber: raw, revisionSuffix: null };
                  return { baseNumber: raw.slice(0, idx), revisionSuffix: raw.slice(idx + 1) || null };
              };
    const numParts = parseParts(ticket);
    const revLabel =
        mod && typeof mod.resolveRevisionLabelForTicket === 'function'
            ? mod.resolveRevisionLabelForTicket(ticket)
            : numParts.revisionSuffix;
    const base = String(numParts.baseNumber || ticket.ticketNumber || '').trim();
    if (revLabel != null && String(revLabel).trim() !== '') {
        return `${base}-${String(revLabel).trim()}`;
    }
    return base;
}

function ticketPopupExternalForOrg(ticket) {
    return window.ticketsModule && typeof window.ticketsModule.isTicketExternalForOrg === 'function'
        ? window.ticketsModule.isTicketExternalForOrg(ticket)
        : !!(ticket && ticket.shared);
}

function buildTicketPopupWorkflowStatusBadgeHtml(ticket, ticketExternalForOrg, opts) {
    opts = opts || {};
    if (
        window.workflowAckModule &&
        typeof window.workflowAckModule.buildWorkflowStatusBadgeHtml === 'function'
    ) {
        const workflowStatus =
            window.ticketsModule &&
            typeof window.ticketsModule.getTicketWorkflowStatusForMap === 'function'
                ? window.ticketsModule.getTicketWorkflowStatusForMap(ticket)
                : '';
        return window.workflowAckModule.buildWorkflowStatusBadgeHtml(ticket, {
            context: 'popup',
            externalForOrg: ticketExternalForOrg,
            status: workflowStatus || undefined,
            variant: opts.variant === 'full' ? 'full' : 'indicator',
        });
    }
    if (opts.variant === 'full') {
        const statusColor = ticketStatusToMapColor(ticket);
        const textColor = statusColor === '#facc15' ? '#000000' : 'var(--app-text-inverse)';
        return (
            `<button type="button" class="ticket-popup-operator-status-badge ticket-popup-workflow-status-badge-btn"` +
            ` style="background: ${statusColor}; color: ${textColor};" title="View readiness requirements">` +
            `${escapeHtmlTicketUi(window.formatWorkflowStatusDisplay(ticket.status))}</button>`
        );
    }
    const label = escapeHtmlTicketUi(window.formatWorkflowStatusDisplay(ticket.status));
    return (
        `<button type="button" class="ticket-popup-status-indicator ticket-popup-status-indicator--neutral ticket-popup-workflow-status-badge-btn"` +
        ` aria-label="Status: ${label}. View readiness requirements" title="View readiness requirements">` +
        `<span class="ticket-popup-status-indicator-icon" aria-hidden="true"></span></button>`
    );
}

function wireTicketPopupWorkflowStatusBadgeClick(host, ticket) {
    if (!host || !ticket || !window.workflowAckModule) return;
    const badges = host.querySelectorAll('.ticket-popup-workflow-status-badge-btn');
    badges.forEach(function (badge) {
        badge.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            window.workflowAckModule.openWorkflowAckModal(ticket);
        };
    });
}

function syncTicketPopupResponsesStatusBadge(popup, ticket, ticketExternalForOrg) {
    if (!popup || !ticket) return;
    const host = popup.querySelector('[data-ticket-popup-responses-status-badge]');
    if (!host) return;
    host.innerHTML = buildTicketPopupWorkflowStatusBadgeHtml(ticket, ticketExternalForOrg, {
        variant: 'full',
    });
    wireTicketPopupWorkflowStatusBadgeClick(host, ticket);
}

function syncTicketPopupHeaderStatusBadge(popup, ticket, ticketExternalForOrg) {
    if (!popup || !ticket) return;
    const titleRow = popup.querySelector('.ticket-popup-title-row');
    if (!titleRow) return;
    let host = popup.querySelector('#ticketPopupHeaderStatusBadge');
    if (!host) {
        host = document.createElement('span');
        host.id = 'ticketPopupHeaderStatusBadge';
        host.className = 'ticket-popup-header-status-host';
        const updating = popup.querySelector('#ticketPopupTitleUpdating');
        titleRow.insertBefore(host, updating || null);
    }
    let html = buildTicketPopupWorkflowStatusBadgeHtml(ticket, ticketExternalForOrg);
    if (
        window.workflowAckModule &&
        typeof window.workflowAckModule.shouldShowRevertAckButton === 'function' &&
        window.workflowAckModule.shouldShowRevertAckButton(ticket, { externalForOrg: ticketExternalForOrg }) &&
        typeof window.workflowAckModule.buildRevertAckButtonHtml === 'function'
    ) {
        html += window.workflowAckModule.buildRevertAckButtonHtml({ context: 'popup' });
    }
    host.innerHTML = html;
    wireTicketPopupWorkflowStatusBadgeClick(host, ticket);
    const revertAckBtn = host.querySelector('.ticket-popup-revert-ack-btn');
    if (revertAckBtn && window.workflowAckModule) {
        revertAckBtn.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            void window.workflowAckModule.revertWorkflowAck(ticket);
        };
    }
    syncTicketPopupResponsesStatusBadge(popup, ticket, ticketExternalForOrg);
}

function clearTicketPopupHeaderStatusBadge(popup) {
    const host = popup && popup.querySelector('#ticketPopupHeaderStatusBadge');
    if (host) host.innerHTML = '';
}

function getTicketPopupPhotoScopeLabel(ticket) {
    if (
        window.ticketImporterModule &&
        typeof window.ticketImporterModule.getPhotoRequirementScopeLabel === 'function'
    ) {
        return window.ticketImporterModule.getPhotoRequirementScopeLabel(ticket);
    }
    return 'this revision';
}

function computeTicketPopupPhotoDisplayStats(ticket) {
    let photoStats = { totalInPolygon: 0, afterCutoff: 0, olderInPolygon: 0, forRequirement: 0 };
    if (ticket.polygon && window.ticketImporterModule && window.ticketImporterModule.countPhotoStatsForTicketRequirement) {
        try {
            photoStats = window.ticketImporterModule.countPhotoStatsForTicketRequirement(ticket);
        } catch (error) {
            console.error('Error counting photos for requirement:', error);
        }
    } else if (ticket.polygon && window.ticketImporterModule && window.ticketImporterModule.countPhotosInTicketPolygon) {
        const n = window.ticketImporterModule.countPhotosInTicketPolygon(ticket.polygon);
        photoStats = { totalInPolygon: n, afterCutoff: n, olderInPolygon: 0, forRequirement: n };
    }
    const photoRegCount = photoStats.forRequirement;
    const photoWindowStats =
        ticket.polygon && window.ticketsModule && typeof window.ticketsModule.getTicketPhotoWindowDisplayStats === 'function'
            ? window.ticketsModule.getTicketPhotoWindowDisplayStats(ticket)
            : { visibleInWindow: photoStats.totalInPolygon, hiddenByWindow: 0, windowLabel: 'Last 90 days' };
    return {
        photoRegCount,
        photoWindowStats,
        photoTotal: photoWindowStats.visibleInWindow,
        photoOlder: photoWindowStats.hiddenByWindow,
    };
}

function patchTicketPopupMediaPhotoCounts(content, ticket) {
    if (!content || !ticket) return;
    const stats = computeTicketPopupPhotoDisplayStats(ticket);
    const scopeLabel = getTicketPopupPhotoScopeLabel(ticket);
    const mod = window.workflowAckComplianceModule;
    const display =
        mod && typeof mod.getPhotoComplianceDisplayState === 'function'
            ? mod.getPhotoComplianceDisplayState(ticket, stats.photoRegCount, scopeLabel)
            : {
                  status: stats.photoRegCount >= 2 ? 'READY' : 'ACTION_REQUIRED',
                  countLabel: `${stats.photoRegCount} / 2`,
                  hint:
                      stats.photoRegCount >= 2
                          ? scopeLabel === 'in area'
                              ? 'Requirement met in area'
                              : 'Requirement met for this revision'
                          : scopeLabel === 'in area'
                            ? 'Review Required: At least 2 photos in area'
                            : 'Review Required: At least 2 photos for this revision',
              };
    const photoStatus = display.status;
    const mediaPanel = content.querySelector('[data-ticket-detail-panel="media"]');
    if (!mediaPanel) return;
    const inner = mediaPanel.querySelector('.ticket-photos-inner');
    if (inner) {
        inner.classList.toggle('ticket-photos-inner--action-required', photoStatus === 'ACTION_REQUIRED');
    }
    const countEl = mediaPanel.querySelector('[data-ticket-popup-photo-count]');
    if (countEl) {
        countEl.textContent = `${display.countLabel} (${scopeLabel}) ${display.met ? window.TICKET_HUB_TEXT.CHECK : window.TICKET_HUB_TEXT.CROSS}`;
    }
    const viewBtn = mediaPanel.querySelector('.ticket-popup-photo-view-btn');
    if (viewBtn) {
        viewBtn.textContent = `View photos (${stats.photoTotal} in area)`;
    }
    const olderEl = mediaPanel.querySelector('[data-ticket-popup-photo-older]');
    if (olderEl) {
        if (stats.photoOlder > 0) {
            olderEl.textContent = `${stats.photoOlder} older photo${stats.photoOlder === 1 ? '' : 's'} in area (outside ${stats.photoWindowStats.windowLabel})`;
            olderEl.hidden = false;
        } else {
            olderEl.textContent = '';
            olderEl.hidden = true;
        }
    }
    const hintEl = mediaPanel.querySelector('[data-ticket-popup-photo-hint]');
    if (hintEl) {
        hintEl.className =
            'ticket-photo-revision-hint ' +
            (photoStatus === 'ACTION_REQUIRED'
                ? 'ticket-photo-revision-hint--action-required'
                : 'ticket-photo-revision-hint--met');
        hintEl.textContent = display.hint;
    }
    if (typeof window.getTicketDetailTabStatuses === 'function' && typeof window.updateTicketDetailTabDot === 'function') {
        const statuses = window.getTicketDetailTabStatuses(ticket);
        window.updateTicketDetailTabDot(content, 'media', statuses.media);
    }
}

function refreshOpenTicketPopupPhotoCounts(ticket) {
    if (!ticket) return;
    const popup = document.getElementById('ticketPopup');
    const content = document.getElementById('ticketPopupContent');
    if (!popup || !content) return;
    const ticketIdKey = ticket.id != null ? String(ticket.id) : '';
    if (popup.getAttribute('data-popup-ticket-id') !== ticketIdKey) return;
    if (window.ticketImporterModule && typeof window.ticketImporterModule.applyTicketStatusFromImporter === 'function') {
        window.ticketImporterModule.applyTicketStatusFromImporter(ticket);
    }
    syncTicketPopupHeaderStatusBadge(popup, ticket, ticketPopupExternalForOrg(ticket));
    patchTicketPopupMediaPhotoCounts(content, ticket);
}

function getTicketPopupResponsesRenderState(ticket) {
    const ticketExternalForOrg =
        window.ticketsModule && typeof window.ticketsModule.isTicketExternalForOrg === 'function'
            ? window.ticketsModule.isTicketExternalForOrg(ticket)
            : !!(ticket && ticket.shared);
    const posrOpsDeferred =
        window.ticketsModule &&
        typeof window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState === 'function' &&
        window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState(ticket);
    const responsesDetailFresh =
        window.ticketsModule &&
        typeof window.ticketsModule.canShowTicketOperatorResponsesNow === 'function' &&
        window.ticketsModule.canShowTicketOperatorResponsesNow(ticket);
    const responsesLoadPending =
        posrOpsDeferred ||
        (window.ticketsModule &&
            typeof window.ticketsModule.isTicketOperatorResponsesLoadPending === 'function' &&
            window.ticketsModule.isTicketOperatorResponsesLoadPending(ticket));
    const canShowResponses = !!responsesDetailFresh && !posrOpsDeferred;
    const operatorResponses =
        canShowResponses && window.ticketsModule && typeof window.ticketsModule.ticketOperatorResponseRowsForDisplay === 'function'
            ? window.ticketsModule.ticketOperatorResponseRowsForDisplay(ticket)
            : canShowResponses
              ? ticket.operatorResponses || []
              : [];
    const providerHistoryLoadPending =
        typeof window.isNgenProviderResponseHistoryLoadPending === 'function' &&
        window.isNgenProviderResponseHistoryLoadPending(ticket);
    return {
        ticketExternalForOrg,
        posrOpsDeferred,
        responsesDetailFresh,
        responsesLoadPending,
        canShowResponses,
        operatorResponses,
        providerHistoryLoadPending,
    };
}

function buildTicketPopupOperatorCommentCellHtml(ticket, response, providerHistoryLoadPending) {
    const supplementalComment = getOperatorResponseCommentSupplementForPopup(ticket, response);
    if (supplementalComment) {
        return `<div>${escapeHtmlTicketUi(supplementalComment)}</div>`;
    }
    if (
        typeof window.resolveOperatorResponseComments === 'function' &&
        window.resolveOperatorResponseComments(ticket, response).missingAuthorityId
    ) {
        return `<span class="ticket-hub-muted" title="Utility ID unavailable — history comments cannot be matched">${window.TICKET_HUB_TEXT.EM_DASH}</span>`;
    }
    if (providerHistoryLoadPending) {
        return '<span class="ticket-responses-comments-loading" aria-busy="true">Loading comments…</span>';
    }
    return '';
}

function buildTicketPopupResponsesCardsHtml(ticket, state) {
    if (
        typeof window.isPosrLaneTicket === 'function' &&
        window.isPosrLaneTicket(ticket) &&
        typeof window.buildPosrPortalDetailsBlurbHtml === 'function'
    ) {
        return window.buildPosrPortalDetailsBlurbHtml({ forHub: false });
    }
    const {
        posrOpsDeferred,
        canShowResponses,
        responsesLoadPending,
        operatorResponses,
    } = state;
    const responsesLoadingHtml =
        typeof window.buildTicketResponsesLoadingHtml === 'function'
            ? window.buildTicketResponsesLoadingHtml()
            : '<div class="ticket-responses-loading" aria-busy="true">Loading operator responses…</div>';
    const responsesEmptyHtml =
        typeof window.buildTicketResponsesEmptyHtml === 'function'
            ? window.buildTicketResponsesEmptyHtml()
            : `<div class="ticket-responses-empty"><p>${
                  typeof window.t === 'function'
                      ? window.t('No operator responses available')
                      : 'No operator responses available'
              }</p></div>`;
    if (responsesLoadPending) {
        return responsesLoadingHtml;
    }
    if (!canShowResponses && !posrOpsDeferred) {
        return responsesLoadingHtml;
    }
    if (operatorResponses.length > 0) {
        if (typeof window.buildOperatorResponseCardsListHtml === 'function') {
            return window.buildOperatorResponseCardsListHtml(ticket, operatorResponses, {
                context: 'popup',
            });
        }
        return responsesEmptyHtml;
    }
    return responsesEmptyHtml;
}

const TICKET_POPUP_DETAIL_TAB_IDS = ['details', 'responses', 'notes'];

function ticketPopupHubPopField(ticket, fieldId, literalFallback) {
    if (window.ticketHubDisplayMap && typeof window.ticketHubDisplayMap.pickTicketField === 'function') {
        const raw = window.ticketHubDisplayMap.pickTicketField(ticket, fieldId);
        if (raw != null && typeof raw === 'boolean') return raw ? 'Yes' : 'No';
        if (raw != null && String(raw).trim() !== '') return escapeHtmlTicketUi(String(raw).trim());
    }
    if (literalFallback != null && String(literalFallback).trim() !== '') {
        return escapeHtmlTicketUi(String(literalFallback).trim());
    }
    return window.TICKET_HUB_TEXT.EM_DASH;
}

function buildTicketPopupDetailsTabHtml(ticket) {
    if (!ticket) return '';
    if (
        typeof window.isPosrLaneTicket === 'function' &&
        window.isPosrLaneTicket(ticket) &&
        typeof window.buildPosrPortalDetailsBlurbHtml === 'function'
    ) {
        const tn = ticket.ticketNumber != null ? escapeHtmlTicketUi(String(ticket.ticketNumber)) : '';
        const blurb = window.buildPosrPortalDetailsBlurbHtml({ forHub: false });
        return `<div class="ticket-detail-tab-panel-inner ticket-popup-details-tab">
            <div class="ticket-hub-kv"><span class="ticket-hub-k">Ticket #</span><span class="ticket-hub-v">${tn}</span></div>
            ${blurb}
        </div>`;
    }
    const workExpiresDisplay = getTicketExpirationForDisplay(ticket);
    const responseProgress = getTicketResponseProgress(ticket);
    const hubPop = (fieldId, literalFallback) => ticketPopupHubPopField(ticket, fieldId, literalFallback);
    const hubTicketTypePopupHtml = (() => {
        const dm = window.ticketHubDisplayMap;
        if (dm && typeof dm.formatTicketTypeWithUsanStatus === 'function') {
            const combined = dm.formatTicketTypeWithUsanStatus(ticket);
            if (combined != null && String(combined).trim() !== '') {
                return escapeHtmlTicketUi(String(combined).trim());
            }
        }
        return hubPop('providerTicketType', ticket.ngenTicketType);
    })();
    const jobNamePopupEscaped = (() => {
        const jn = getTicketJobNameDisplayValue(ticket);
        return jn ? escapeHtmlTicketUi(jn) : window.TICKET_HUB_TEXT.EM_DASH;
    })();
    const projectsFieldHtml =
        typeof window.buildTicketProjectsFieldHtml === 'function'
            ? window.buildTicketProjectsFieldHtml(ticket)
            : '';
    const submittedThisRevPopupDisplay = formatDate(
        window.ticketHubDisplayMap && typeof window.ticketHubDisplayMap.pickTicketField === 'function'
            ? window.ticketHubDisplayMap.pickTicketField(ticket, 'providerLodgedOn')
            : null
    );
    const legalStartPopupDisplay = formatDate(
        window.ticketHubDisplayMap && typeof window.ticketHubDisplayMap.pickTicketField === 'function'
            ? window.ticketHubDisplayMap.pickTicketField(ticket, 'legalStartDate')
            : ticket.legalStartDate
    );
    let eventCount = 0;
    try {
        let reports = [];
        if (window.reportedEventsStore && window.reportedEventsStore.getReportsForCurrentOrg) {
            reports = window.reportedEventsStore.getReportsForCurrentOrg();
        }
        if (!reports.length) {
            reports = JSON.parse(localStorage.getItem('dirtReports') || '[]');
        }
        eventCount = reports.filter(
            (r) =>
                r.ticketId === ticket.id ||
                (r.ticketNumber != null &&
                    ticket.ticketNumber != null &&
                    String(r.ticketNumber) === String(ticket.ticketNumber))
        ).length;
    } catch (error) {
        console.error('Error counting events:', error);
    }
    const reportedEventsBlockHtml =
        typeof buildTicketHubReportedEventsSectionHtml === 'function'
            ? buildTicketHubReportedEventsSectionHtml(ticket, { forPopup: true })
            : eventCount > 0
              ? `<div class="ticket-popup-row" style="margin-top: 0.5rem; padding: 0.75rem; background: var(--app-bg-page); border: 1px solid var(--app-bg-muted); border-radius: 0.375rem;">
                        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                            <div>
                                <div style="font-size: 0.875rem; color: var(--app-text-secondary); margin-bottom: 0.25rem;">Reported Events</div>
                                <div style="font-size: 1.25rem; font-weight: 600; color: var(--app-text-inverse);">${eventCount}</div>
                            </div>
                            <button type="button" class="ticket-popup-events-btn" style="padding: 0.5rem 1rem; background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse)); border: none; border-radius: 0.25rem; cursor: pointer; font-size: 0.875rem; font-weight: 500;">View Events</button>
                        </div>
                    </div>`
              : '';
    return `<div class="ticket-detail-tab-panel-inner">
                <div class="ticket-popup-rows">
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Organization:</span>
                        <span class="ticket-popup-value">${escapeHtmlTicketUi(getTicketOrganizationDisplayName(ticket))}</span>
                    </div>
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Job name:</span>
                        <span class="ticket-popup-value">${jobNamePopupEscaped}</span>
                    </div>
                    ${projectsFieldHtml}
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Address:</span>
                        <span class="ticket-popup-value">${hubPop('digSiteAddress', ticket.address || ticket.locationSummary)}</span>
                    </div>
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Job Start:</span>
                        <span class="ticket-popup-value">${formatDate(ticket.startTime)}</span>
                    </div>
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Legal start:</span>
                        <span class="ticket-popup-value">${legalStartPopupDisplay}</span>
                    </div>
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Submitted (this rev):</span>
                        <span class="ticket-popup-value">${submittedThisRevPopupDisplay}</span>
                    </div>
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Work Expires:</span>
                        <span class="ticket-popup-value">${workExpiresDisplay ? formatDate(workExpiresDisplay) : window.TICKET_HUB_TEXT.EM_DASH}</span>
                    </div>
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Ticket type:</span>
                        <span class="ticket-popup-value">${hubTicketTypePopupHtml}</span>
                    </div>
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Scope of Work:</span>
                        <span class="ticket-popup-value">${hubPop('ticketScope', ticket.scopeOfWork)}</span>
                    </div>
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Created By:</span>
                        <span class="ticket-popup-value">${hubPop('createdBy', ticket.createdBy)}</span>
                    </div>
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Total Operators:</span>
                        <span class="ticket-popup-value">${responseProgress.required != null ? responseProgress.required : responseProgress.received} total</span>
                    </div>
                    ${ticket.stationCodes && ticket.stationCodes.length > 0 ? `
                    <div class="ticket-popup-row">
                        <span class="ticket-popup-label">Station Codes:</span>
                        <span class="ticket-popup-value">${escapeHtmlTicketUi(ticket.stationCodes.join(', '))}</span>
                    </div>
                    ` : ''}
                </div>
                ${reportedEventsBlockHtml}
            </div>`;
}

function captureTicketPopupTabUiState(content, popup, ticketIdKey) {
    if (!content || !popup || !ticketIdKey) return null;
    if (!popup.classList.contains('show')) return null;
    if (popup.getAttribute('data-popup-ticket-id') !== ticketIdKey) return null;
    const activeBtn = content.querySelector('.ticket-detail-tab--active');
    const tabId = activeBtn && activeBtn.getAttribute('data-ticket-detail-tab');
    if (!tabId || !TICKET_POPUP_DETAIL_TAB_IDS.includes(tabId)) return null;
    const activePanel = content.querySelector(`[data-ticket-detail-panel="${tabId}"]`);
    return {
        tabId,
        scrollTop: activePanel && activePanel.scrollTop ? activePanel.scrollTop : 0,
    };
}

function restoreTicketPopupTabUiState(content, preserved) {
    if (!content || !preserved || !preserved.tabId) return;
    const panel = content.querySelector(`[data-ticket-detail-panel="${preserved.tabId}"]`);
    if (panel && preserved.scrollTop > 0) {
        panel.scrollTop = preserved.scrollTop;
    }
}

/** Patch open popup content without a full re-render (avoids duplicate API calls and flicker). */
function patchOpenTicketPopupDetail(ticket) {
    if (!ticket) return;
    const popup = document.getElementById('ticketPopup');
    const content = document.getElementById('ticketPopupContent');
    const title = document.getElementById('ticketPopupTitle');
    if (!popup || !content) return;
    const ticketIdKey = ticket.id != null ? String(ticket.id) : '';
    if (popup.getAttribute('data-popup-ticket-id') !== ticketIdKey) return;

    applyTicketStatusFromImporter(ticket);

    if (title) {
        setTicketPopupIdentity(ticket);
    }

    const ticketExternalForOrg = ticketPopupExternalForOrg(ticket);
    syncTicketPopupHeaderStatusBadge(popup, ticket, ticketExternalForOrg);

    const detailsPanel = content.querySelector('[data-ticket-detail-panel="details"]');
    if (detailsPanel) {
        detailsPanel.innerHTML = buildTicketPopupDetailsTabHtml(ticket);
    }

    const state = getTicketPopupResponsesRenderState(ticket);
    const responsesCardsHTML = buildTicketPopupResponsesCardsHtml(ticket, state);
    const responsesPanel = content.querySelector('[data-ticket-detail-panel="responses"]');
    if (responsesPanel) {
        const wrapper = responsesPanel.querySelector('.ticket-responses-wrapper');
        if (wrapper) {
            wrapper.innerHTML = responsesCardsHTML;
        }
        const badgeHost = responsesPanel.querySelector('[data-ticket-popup-responses-status-badge]');
        if (badgeHost) {
            badgeHost.innerHTML = buildTicketPopupWorkflowStatusBadgeHtml(ticket, ticketExternalForOrg, {
                variant: 'full',
            });
        }
    }

    if (typeof window.getTicketDetailTabStatuses === 'function' && typeof window.updateTicketDetailTabDot === 'function') {
        const statuses = window.getTicketDetailTabStatuses(ticket);
        TICKET_POPUP_DETAIL_TAB_IDS.forEach((tabId) => {
            window.updateTicketDetailTabDot(content, tabId, statuses[tabId]);
        });
    }

    wireTicketPopupOperatorResponseActions(state.canShowResponses ? ticket : null);
    wireTicketPopupWorkflowStatusBadgeClick(content, ticket);
    if (
        window.ticketActionsMenu &&
        typeof window.ticketActionsMenu.syncTicketActionsMenu === 'function'
    ) {
        window.ticketActionsMenu.syncTicketActionsMenu(content, ticket, { context: 'popup' });
    }

    if (typeof window.wireTicketProjectsField === 'function') {
        window.wireTicketProjectsField(ticket);
    }

    refreshOpenTicketPopupPhotoCounts(ticket);

    const refreshBusy =
        typeof ticketSelectionRefreshLoading === 'function' && ticketSelectionRefreshLoading(ticket);
    popup.classList.toggle('ticket-popup--refresh-busy', refreshBusy);
    syncTicketPopupViewportRefreshLock(popup, refreshBusy);
    syncTicketPopupHeaderUpdatingIndicator();
    syncTicketPopupOverlayScroll(content);
}

function scheduleTicketPopupAuxiliaryLoad(popup, content, ticket) {
    if (!popup || !content || !ticket) return;
    const ticketIdKey = ticket.id != null ? String(ticket.id) : '';
    void Promise.resolve().then(async () => {
        if (popup.getAttribute('data-popup-ticket-id') !== ticketIdKey) return;
        if (ticket.polygon && window.ticketsModule && typeof window.ticketsModule.ensureTicketPhotosFromApi === 'function') {
            await window.ticketsModule.ensureTicketPhotosFromApi(ticket, 'all');
        }
        if (popup.getAttribute('data-popup-ticket-id') !== ticketIdKey) return;
        refreshOpenTicketPopupPhotoCounts(ticket);
        if (typeof window.fetchTicketNotesReviewStatus === 'function') {
            void window.fetchTicketNotesReviewStatus(ticket).then(() => {
                if (popup.getAttribute('data-popup-ticket-id') !== ticketIdKey) return;
                if (typeof window.updateTicketDetailTabDot === 'function') {
                    window.updateTicketDetailTabDot(
                        content,
                        'notes',
                        ticket.notesReviewRequired ? 'action-required' : null
                    );
                }
            });
        }
    });
}

let ticketPopupOverlayScrollResizeBound = false;

function syncTicketPopupOverlayScroll(content) {
    const mod = window.overlayScrollModule;
    if (!mod || !content) return;
    const mobile = typeof isMobileView === 'function' ? isMobileView() : window.matchMedia('(max-width: 768px)').matches;
    const panels = content.querySelector('.ticket-detail-tab-panels');
    const contentWasScrollTarget = content.classList.contains('app-overlay-scroll');
    const panelsWasScrollTarget = !!(panels && panels.classList.contains('app-overlay-scroll'));

    if (mobile) {
        if (panels) {
            panels.classList.remove('app-overlay-scroll');
            if (panelsWasScrollTarget && typeof mod.detachOverlayScroll === 'function') {
                mod.detachOverlayScroll(panels);
            }
        }
        content.classList.add('app-overlay-scroll');
    } else {
        content.classList.remove('app-overlay-scroll');
        if (contentWasScrollTarget && typeof mod.detachOverlayScroll === 'function') {
            mod.detachOverlayScroll(content);
        }
        if (panels) panels.classList.add('app-overlay-scroll');
    }
    if (typeof mod.ensureOverlayScroll === 'function') {
        mod.ensureOverlayScroll(content);
    }
}

function ensureTicketPopupOverlayScrollResizeListener() {
    if (ticketPopupOverlayScrollResizeBound) return;
    ticketPopupOverlayScrollResizeBound = true;
    let resizeRaf = null;
    window.addEventListener('resize', function () {
        const popup = document.getElementById('ticketPopup');
        if (!popup || !popup.classList.contains('show')) return;
        const content = document.getElementById('ticketPopupContent');
        if (!content) return;
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(function () {
            resizeRaf = null;
            syncTicketPopupOverlayScroll(content);
        });
    });
}

// Show ticket popup
async function showTicketPopup(ticket, opts) {
    const options = opts || {};
    const popup = document.getElementById('ticketPopup');
    const hubWin = document.getElementById('ticketHubWindow');
    const hubOpen = !!(hubWin && hubWin.classList.contains('show'));
    const allowOverTicketHub = options.allowOverTicketHub === true;
    /** Redraw after db-detail/lite hydrate — do not re-kick refresh/hydrate loops. */
    const skipDetailHydrate = options.skipDetailHydrate === true;
    const popupAlreadyOverHub = popup && popup.classList.contains('ticket-popup--above-hub');
    const stackAboveHub = allowOverTicketHub || (hubOpen && popupAlreadyOverHub);

    // Auto-refresh before hub gate — map clicks still refresh when Ticket Hub is open (popup may be suppressed).
    if (
        !skipDetailHydrate &&
        ticket &&
        window.ticketsModule &&
        typeof window.ticketsModule.ticketMayAutoRefreshOnPopupOpen === 'function' &&
        window.ticketsModule.ticketMayAutoRefreshOnPopupOpen(ticket) &&
        typeof refreshTicketFrom811 === 'function'
    ) {
        void refreshTicketFrom811(ticket.ticketNumber, { forceRefresh: false, popupOpen: true });
    }

    if (hubOpen && !stackAboveHub) {
        return;
    }

    const title = document.getElementById('ticketPopupTitle');
    const content = document.getElementById('ticketPopupContent');
    
    if (!popup || !title || !content) return;

    const ticketIdKey = ticket.id != null ? String(ticket.id) : '';
    const popupAlreadyOpen =
        popup.classList.contains('show') &&
        ticketIdKey !== '' &&
        popup.getAttribute('data-popup-ticket-id') === ticketIdKey;

    if (popupAlreadyOpen && skipDetailHydrate) {
        patchOpenTicketPopupDetail(ticket);
        return;
    }

    const preservedTabUi = captureTicketPopupTabUiState(content, popup, ticketIdKey);
    const openingFresh = !popupAlreadyOpen;
    let operatorResponsesHydrateStarted = false;
    if (
        !skipDetailHydrate &&
        window.ticketsModule &&
        typeof window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState === 'function' &&
        window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState(ticket) &&
        typeof window.ticketsModule.ensureTicketOperatorResponsesLoaded === 'function'
    ) {
        operatorResponsesHydrateStarted = true;
        void window.ticketsModule.ensureTicketOperatorResponsesLoaded(ticket.ticketNumber, { ticket });
    }

    void (async () => {
        try {
            if (window.reportedEventsStore && typeof window.reportedEventsStore.ensureLoaded === 'function') {
                await window.reportedEventsStore.ensureLoaded();
            }
        } catch (lazyErr) {
            console.warn('[tickets] popup lazy prefetch:', lazyErr.message || lazyErr);
        }
    })();

    ensureTicketPopupDomSurfaceShield();

    if (openingFresh) {
        removeTicketPopupViewportRefreshLock(popup);
    }
    popup.classList.toggle('ticket-popup--above-hub', stackAboveHub);

    popup.setAttribute('data-popup-ticket-id', ticket.id != null ? String(ticket.id) : '');

    // Set title
    setTicketPopupIdentity(ticket);
    
    // Add delete button to header actions (Dev only)
    const actionsContainer = popup.querySelector('.ticket-popup-actions');
    if (actionsContainer) {
        // Remove existing refresh 811 button if any
        const existingRefreshBtn = actionsContainer.querySelector('.ticket-refresh-811-button');
        if (existingRefreshBtn) {
            existingRefreshBtn.remove();
        }
        
        if (ticketMapPopupMayRefresh811(ticket)) {
            const refreshTitle = ticketMapPopupRefreshTitle(ticket);
            const refreshButton = document.createElement('button');
            refreshButton.type = 'button';
            refreshButton.className = 'ticket-refresh-811-button data-window-button';
            refreshButton.title = refreshTitle;
            refreshButton.setAttribute('aria-label', refreshTitle);
            refreshButton.innerHTML = TICKET_HUB_SYNC_ICON_SVG;
            refreshButton.onclick = function(e) {
                e.stopPropagation();
                refreshTicketFrom811(ticket.ticketNumber, { forceRefresh: true });
            };
            const closeButton = actionsContainer.querySelector('.ticket-popup-close');
            if (closeButton) {
                actionsContainer.insertBefore(refreshButton, closeButton);
            } else {
                actionsContainer.appendChild(refreshButton);
            }
        }
    }
    
    applyTicketStatusFromImporter(ticket);
    const ticketExternalForOrg = ticketPopupExternalForOrg(ticket);
    syncTicketPopupHeaderStatusBadge(popup, ticket, ticketExternalForOrg);

    const posrOpsDeferred =
        window.ticketsModule &&
        typeof window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState === 'function' &&
        window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState(ticket);
    const responsesDetailFresh =
        window.ticketsModule &&
        typeof window.ticketsModule.canShowTicketOperatorResponsesNow === 'function' &&
        window.ticketsModule.canShowTicketOperatorResponsesNow(ticket);
    const shouldAutoRefreshOnPopupOpen =
        window.ticketsModule &&
        typeof window.ticketsModule.ticketMayAutoRefreshOnPopupOpen === 'function' &&
        window.ticketsModule.ticketMayAutoRefreshOnPopupOpen(ticket);
    // Must respect skipDetailHydrate — redraw after ensure/refresh uses it to avoid
    // ensure → redraw → ensure loops when nGen credentials are missing/invalid.
    const responsesNeedLoad =
        !skipDetailHydrate &&
        !shouldAutoRefreshOnPopupOpen &&
        ticket.ticketNumber &&
        window.ticketsModule &&
        typeof window.ticketsModule.ensureTicketOperatorResponsesLoaded === 'function' &&
        (!responsesDetailFresh || posrOpsDeferred);
    if (responsesNeedLoad && !operatorResponsesHydrateStarted) {
        void window.ticketsModule.ensureTicketOperatorResponsesLoaded(ticket.ticketNumber, { ticket });
    }
    const responsesLoadPending =
        posrOpsDeferred ||
        (window.ticketsModule &&
            typeof window.ticketsModule.isTicketOperatorResponsesLoadPending === 'function' &&
            window.ticketsModule.isTicketOperatorResponsesLoadPending(ticket));
    const canShowResponses = !!responsesDetailFresh && !posrOpsDeferred;

    const responsesState = getTicketPopupResponsesRenderState(ticket);
    const responsesCardsHTML = buildTicketPopupResponsesCardsHtml(ticket, responsesState);

    const refreshBusy =
        typeof ticketSelectionRefreshLoading === 'function' && ticketSelectionRefreshLoading(ticket);

    function truthyUsanTicketFlag(v) {
        if (window.ticketRemarkFlow && typeof window.ticketRemarkFlow.truthyUsanTicketFlag === 'function') {
            return window.ticketRemarkFlow.truthyUsanTicketFlag(v);
        }
        return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
    }

    const ticketPopupUsanActionsHtml =
        window.ticketActionsMenu &&
        typeof window.ticketActionsMenu.buildTicketDetailToolbarHtml === 'function'
            ? window.ticketActionsMenu.buildTicketDetailToolbarHtml(ticket, { context: 'popup' })
            : '';

    const popupFixedActionsHtml = ticketPopupUsanActionsHtml
        ? `<div class="ticket-detail-actions-collapsible ticket-popup-section" data-ticket-popup-collapsible>
            <button type="button" class="ticket-detail-actions-collapse-toggle ticket-section-collapse-toggle" data-ticket-popup-collapse-toggle aria-expanded="true">Actions</button>
            <div class="ticket-detail-actions-collapsible-body">
                <div class="ticket-popup-detail-actions-bar">${ticketPopupUsanActionsHtml}</div>
            </div>
        </div>`
        : '';

    const detailsTabHtml = buildTicketPopupDetailsTabHtml(ticket);

    const responsesStatusBadgeHtml = buildTicketPopupWorkflowStatusBadgeHtml(
        ticket,
        ticketExternalForOrg,
        { variant: 'full' }
    );
    const popupPosrLane =
        typeof window.isPosrLaneTicket === 'function' && window.isPosrLaneTicket(ticket);
    const popupHistoryBtnHtml = popupPosrLane
        ? ''
        : `<button type="button" class="ticket-section-title ticket-section-title--link" data-ticket-response-history-open title="View full response history" onclick="event.stopPropagation(); openTicketResponseHistoryFromPopup('${escapeHtmlTicketUi(ticket.ticketNumber || '')}', this);">History</button>`;
    const responsesTabHtml = `<div class="ticket-detail-tab-panel-inner ticket-popup-responses-tab">
                <div class="ticket-detail-tab-toolbar ticket-section-header-actions ticket-section-header-actions--responses">
                    ${popupHistoryBtnHtml}
                    <button type="button" class="ticket-posr-portal-btn" onclick="event.stopPropagation(); openPosrSearchAndCopy811Ticket();" title="Copy ticket number to clipboard and open external search">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        Check POSR
                    </button>
                    <span class="ticket-popup-responses-status-host" data-ticket-popup-responses-status-badge>${responsesStatusBadgeHtml}</span>
                </div>
                <div class="ticket-responses-wrapper">
                    ${responsesCardsHTML}
                </div>
            </div>`;

    const notesReadOnly =
        typeof window.ticketNotesReadOnlyForTicket === 'function' &&
        window.ticketNotesReadOnlyForTicket(ticket);
    const notesTabHtml =
        typeof window.buildTicketNotesPanelShellHtml === 'function'
            ? window.buildTicketNotesPanelShellHtml(ticket, { readOnly: notesReadOnly })
            : '<p class="ticket-notes-empty">Notes unavailable.</p>';

    const tabStatuses =
        typeof window.getTicketDetailTabStatuses === 'function'
            ? window.getTicketDetailTabStatuses(ticket)
            : {};
    const tabCounts =
        typeof window.getTicketDetailTabCounts === 'function'
            ? window.getTicketDetailTabCounts(ticket)
            : {};
    const preferenceTab =
        typeof window.resolveTicketDetailDefaultTab === 'function'
            ? window.resolveTicketDetailDefaultTab(ticket, tabStatuses)
            : 'responses';
    const defaultTab =
        preservedTabUi && preservedTabUi.tabId && preservedTabUi.tabId !== 'media'
            ? preservedTabUi.tabId
            : preferenceTab;
    const tabsHtml =
        typeof window.buildTicketDetailTabsHtml === 'function'
            ? window.buildTicketDetailTabsHtml({
                  detailsHtml: detailsTabHtml,
                  responsesHtml: responsesTabHtml,
                  notesHtml: notesTabHtml,
                  tabStatuses,
                  tabCounts,
                  defaultTab,
              })
            : detailsTabHtml;

    const ticketPopupBodyHtml = `${popupFixedActionsHtml}${tabsHtml}`;

    content.innerHTML = ticketPopupBodyHtml;

    popup.classList.toggle('ticket-popup--refresh-busy', refreshBusy);
    syncTicketPopupViewportRefreshLock(popup, refreshBusy);
    syncTicketPopupHeaderUpdatingIndicator();

    wireTicketPopupOperatorResponseActions(canShowResponses ? ticket : null);
    wireTicketPopupTicketActions(ticket);
    if (typeof window.wireTicketDetailTabs === 'function') {
        window.wireTicketDetailTabs(content, {
            onTabChange(tabId) {
                if (tabId === 'notes') {
                    const notesPanel = content.querySelector('[data-ticket-detail-panel="notes"]');
                    if (!notesPanel) return;
                    if (typeof window.wireTicketNotesPanel === 'function') {
                        window.wireTicketNotesPanel(notesPanel, ticket);
                    }
                    if (notesPanel.dataset.ticketNotesLoaded === '1') return;
                    notesPanel.dataset.ticketNotesLoaded = '1';
                    if (typeof window.loadTicketNotesForPanel === 'function') {
                        void window.loadTicketNotesForPanel(ticket, notesPanel);
                    }
                    return;
                }
                if (tabId === 'details') {
                    if (typeof window.wireTicketProjectsField === 'function') {
                        window.wireTicketProjectsField(ticket);
                    }
                }
            },
        });
    }
    if (typeof window.wireTicketProjectsField === 'function') {
        window.wireTicketProjectsField(ticket);
    }
    restoreTicketPopupTabUiState(content, preservedTabUi);
    if (window.operatorDirectoryPhones && typeof window.operatorDirectoryPhones.loadDirectoryMap === 'function') {
        if (canShowResponses) {
            void window.operatorDirectoryPhones.loadDirectoryMap(ticket);
        }
    }
    initTicketPopupExpandableSections();

    scheduleTicketPopupAuxiliaryLoad(popup, content, ticket);

    (function wireTicketPopupMockPreviewButtons() {
        const documentPackBtn = content.querySelector('.ticket-popup-document-pack-btn');
        if (documentPackBtn) {
            documentPackBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (
                    window.ticketDocumentPackFlow &&
                    typeof window.ticketDocumentPackFlow.openTicketDocumentPackViewer === 'function'
                ) {
                    void window.ticketDocumentPackFlow.openTicketDocumentPackViewer(ticket, documentPackBtn);
                }
            };
        }
        const openProjectBtn = content.querySelector('.ticket-popup-open-project-btn');
        if (openProjectBtn) {
            openProjectBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (typeof window.openTicketProjectInHub === 'function') {
                    void window.openTicketProjectInHub(ticket);
                }
            };
        }
        const renewBtn = content.querySelector('.ticket-popup-mock-btn-renew');
        const remarkBtn = content.querySelector('.ticket-popup-mock-btn-remark');
        if (renewBtn) {
            renewBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                const useApi =
                    typeof window.isTicketRenewalHubEnabled === 'function' &&
                    window.isTicketRenewalHubEnabled() &&
                    window.ticketRenewalBulkFlow &&
                    typeof window.ticketRenewalBulkFlow.openBulkRenewalFromTickets === 'function';
                if (useApi) {
                    window.ticketRenewalBulkFlow.openBulkRenewalFromTickets([ticket]);
                    return;
                }
                const flow =
                    typeof window !== 'undefined' &&
                    window.renewalUxMockFlow &&
                    typeof window.renewalUxMockFlow.openSingleRenewalMockFromTicket === 'function'
                        ? window.renewalUxMockFlow
                        : null;
                if (!flow) {
                    if (typeof window.appAlert === 'function')
                        void window.appAlert('Renew preview failed to load. Refresh the map page.');
                    return;
                }
                flow.openSingleRenewalMockFromTicket(ticket);
            };
        }
        if (remarkBtn) {
            remarkBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                const useApi =
                    typeof window.isTicketRenewalHubEnabled === 'function' &&
                    window.isTicketRenewalHubEnabled() &&
                    window.ticketRemarkFlow &&
                    typeof window.ticketRemarkFlow.openSingleRemarkFromTicket === 'function';
                if (useApi) {
                    window.ticketRemarkFlow.openRemarkFromTicket(ticket);
                    return;
                }
                openTicketPopupMockPreviewModal('remark', ticket);
            };
        }
        if (
            window.ticketActionsMenu &&
            typeof window.ticketActionsMenu.wireTicketActionsMenu === 'function'
        ) {
            window.ticketActionsMenu.wireTicketActionsMenu(content, ticket);
        }
        const reportEventBtn = content.querySelector('.ticket-popup-report-event-btn');
        if (reportEventBtn) {
            reportEventBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (typeof window.reportEventForTicket !== 'function') return;
                reportEventBtn.disabled = true;
                void window.reportEventForTicket(ticket).finally(() => {
                    reportEventBtn.disabled = false;
                });
            };
        }
        const requestServicesBtn = content.querySelector('.ticket-popup-request-services-btn');
        if (requestServicesBtn) {
            requestServicesBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (typeof window.openServiceRequestModal === 'function') {
                    window.openServiceRequestModal([ticket]);
                    return;
                }
                if (typeof window.requestSiteDocumentationForTicket === 'function') {
                    window.requestSiteDocumentationForTicket(ticket);
                    return;
                }
                if (typeof window.requestSiteDocumentationForCurrentTicket === 'function') {
                    void window.requestSiteDocumentationForCurrentTicket(requestServicesBtn);
                }
            };
        }
        wireTicketPopupWorkflowStatusBadgeClick(content, ticket);
        const readyBtn = content.querySelector('.ticket-popup-ready-btn');
        if (readyBtn && window.workflowAckModule) {
            readyBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                window.workflowAckModule.openWorkflowAckModal(ticket);
            };
        }
        const revertAckBtn = content.querySelector('.ticket-popup-revert-ack-btn');
        if (revertAckBtn && window.workflowAckModule) {
            revertAckBtn.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                void window.workflowAckModule.revertWorkflowAck(ticket);
            };
        }
    })();

    // Load saved height from profile
    loadTicketPopupHeight();
    
    // On mobile: explicit open path height first; otherwise preserve current height or use profile.
    if (isMobileView()) {
        const explicitMobileHeight =
            options.mobileHeight === 'full' || options.mobileHeight === 'half' ? options.mobileHeight : null;
        const currentMobileHeight = popup.classList.contains('ticket-popup-mobile-full')
            ? 'full'
            : popup.classList.contains('ticket-popup-mobile-halfway')
              ? 'half'
              : null;
        const profileMobileHeight =
            typeof window.getTicketPopupMobileHeightPreference === 'function'
                ? window.getTicketPopupMobileHeightPreference()
                : 'half';
        const mobileH = explicitMobileHeight || currentMobileHeight || profileMobileHeight;
        applyTicketPopupMobileHeight(popup, mobileH);
    } else {
        popup.classList.remove('ticket-popup-mobile-halfway', 'ticket-popup-mobile-full');
    }
    
    // Initialize resize functionality
    initTicketPopupResize();

    popup.classList.add('show');
    syncTicketPopupHeaderStatusBadge(popup, ticket, ticketPopupExternalForOrg(ticket));
    syncTicketPopupMobileHeightToggle();
    if (typeof window.syncTicketPopupRefreshLockForDisplayedTicket === 'function') {
        window.syncTicketPopupRefreshLockForDisplayedTicket();
    }
    if (typeof window.syncTicketPopupHeaderUpdatingIndicator === 'function') {
        window.syncTicketPopupHeaderUpdatingIndicator();
    }
    ensureTicketPopupOverlayScrollResizeListener();
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
            syncTicketPopupOverlayScroll(content);
        });
    } else {
        syncTicketPopupOverlayScroll(content);
    }

    // If db-detail finished before .show, repaint with the richer live ticket (skip re-hydrate).
    if (
        !skipDetailHydrate &&
        ticket &&
        window.ticketsModule &&
        typeof window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState === 'function' &&
        window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState(ticket)
    ) {
        // Prefer findLive… so expired/project tickets parked outside ORG_TICKETS are found.
        const liveAfterOpen =
            (window.ticketsModule && typeof window.ticketsModule.findLiveTicketInLocalCollections === 'function'
                ? window.ticketsModule.findLiveTicketInLocalCollections(ticket)
                : null) ||
            (window.ORG_TICKETS || []).find((t) => t && ticket.id != null && ticketIdEquals(t.id, ticket.id)) ||
            (window.ORG_TICKETS || []).find(
                (t) =>
                    t &&
                    t.ticketNumber != null &&
                    ticket.ticketNumber != null &&
                    String(t.ticketNumber).trim() === String(ticket.ticketNumber).trim()
            );
        if (
            liveAfterOpen &&
            typeof window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState === 'function' &&
            !window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState(liveAfterOpen)
        ) {
            patchOpenTicketPopupDetail(liveAfterOpen);
        }
    }

    if (
        !skipDetailHydrate &&
        typeof window.scheduleNgenProviderResponseHistoryIfNeeded === 'function'
    ) {
        const liveForHistory =
            (window.ORG_TICKETS || []).find((t) => t && ticket.id != null && ticketIdEquals(t.id, ticket.id)) ||
            ticket;
        window.scheduleNgenProviderResponseHistoryIfNeeded(liveForHistory);
    }
}

// Initialize ticket popup resize functionality (only once)
let ticketPopupResizeInitialized = false;
function initTicketPopupResize() {
    if (ticketPopupResizeInitialized) return;
    
    const popup = document.getElementById('ticketPopup');
    const resizeHandle = document.getElementById('ticketPopupResizeHandle');
    const resizeHandleVertical = document.getElementById('ticketPopupResizeHandleVertical');
    
    if (!popup || !resizeHandle || !resizeHandleVertical) return;
    
    ticketPopupResizeInitialized = true;
    
    // Height resize
    let isResizingHeight = false;
    let startY = 0;
    let startHeight = 0;
    
    resizeHandle.addEventListener('mousedown', function(e) {
        isResizingHeight = true;
        startY = e.clientY;
        startHeight = popup.offsetHeight;
        
        // Disable transition during resize
        popup.classList.add('resizing');
        
        document.addEventListener('mousemove', handleHeightResize);
        document.addEventListener('mouseup', stopHeightResize);
        
        e.preventDefault();
        e.stopPropagation();
    });
    
    function handleHeightResize(e) {
        if (!isResizingHeight) return;
        
        const deltaY = startY - e.clientY; // Inverted because we're resizing from bottom
        const newHeight = Math.max(200, Math.min(window.innerHeight - 50, startHeight + deltaY));
        
        popup.style.height = newHeight + 'px';
        popup.style.maxHeight = newHeight + 'px';
    }
    
    function stopHeightResize() {
        if (isResizingHeight) {
            isResizingHeight = false;
            // Re-enable transition
            popup.classList.remove('resizing');
            saveTicketPopupDimensions();
        }
        
        document.removeEventListener('mousemove', handleHeightResize);
        document.removeEventListener('mouseup', stopHeightResize);
    }
    
    // Width resize
    let isResizingWidth = false;
    let startX = 0;
    let startWidth = 0;
    let startLeft = 0;
    
    resizeHandleVertical.addEventListener('mousedown', function(e) {
        isResizingWidth = true;
        startX = e.clientX;
        startWidth = popup.offsetWidth;
        // Get current left position (accounting for transform)
        const rect = popup.getBoundingClientRect();
        startLeft = rect.left;
        
        // Disable transition during resize
        popup.classList.add('resizing');
        
        document.addEventListener('mousemove', handleWidthResize);
        document.addEventListener('mouseup', stopWidthResize);
        
        e.preventDefault();
        e.stopPropagation();
    });
    
    function handleWidthResize(e) {
        if (!isResizingWidth) return;
        
        const deltaX = e.clientX - startX;
        const newWidth = Math.max(400, Math.min(window.innerWidth - 50, startWidth + deltaX));
        
        popup.style.width = newWidth + 'px';
        popup.style.maxWidth = newWidth + 'px';
    }
    
    function stopWidthResize() {
        if (isResizingWidth) {
            isResizingWidth = false;
            // Re-enable transition
            popup.classList.remove('resizing');
            saveTicketPopupDimensions();
        }
        
        document.removeEventListener('mousemove', handleWidthResize);
        document.removeEventListener('mouseup', stopWidthResize);
    }
}

// Helper to get user-specific storage key (same as in ui.js)
function getUserStorageKey(baseKey) {
    const currentUser = window.authModule?.getCurrentUser();
    if (currentUser && currentUser.id) {
        return `${baseKey}_user_${currentUser.id}`;
    }
    return baseKey; // Fallback for unauthenticated or missing user ID
}

// Save ticket popup dimensions for the current user (persists when they adjust the panel)
function saveTicketPopupDimensions() {
    try {
        const popup = document.getElementById('ticketPopup');
        if (!popup) return;
        
        const storageKey = getUserStorageKey('ticketPopupDimensions');
        const data = {
            ticketPopupHeight: popup.offsetHeight,
            ticketPopupWidth: popup.offsetWidth,
            lastUpdated: new Date().toISOString()
        };
        localStorage.setItem(storageKey, JSON.stringify(data));
        if (typeof window.schedulePersistUserUiPreferencesToServer === 'function') {
            window.schedulePersistUserUiPreferencesToServer();
        }
    } catch (error) {
        console.error('Error saving ticket popup dimensions:', error);
    }
}

// Load ticket popup dimensions for the current user (skipped on mobile; mobile uses 50vh)
function loadTicketPopupHeight() {
    try {
        const popup = document.getElementById('ticketPopup');
        if (!popup) return;
        if (isMobileView()) return; // Mobile uses fixed height from profile in showTicketPopup
        const storageKey = getUserStorageKey('ticketPopupDimensions');
        const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
        
        if (data.ticketPopupHeight) {
            const height = Math.max(200, Math.min(window.innerHeight - 50, data.ticketPopupHeight));
            popup.style.height = height + 'px';
            popup.style.maxHeight = height + 'px';
        }
        
        if (data.ticketPopupWidth) {
            const width = Math.max(400, Math.min(window.innerWidth - 50, data.ticketPopupWidth));
            popup.style.width = width + 'px';
            popup.style.maxWidth = width + 'px';
        }
    } catch (error) {
        console.error('Error loading ticket popup dimensions:', error);
    }
}

// Initialize expandable sections (Ticket Details and Operator Responses always; Photos on mobile).
function applyTicketPopupMobileHeight(popup, mode) {
    if (!popup) return;
    const full = mode === 'full';
    popup.classList.remove('ticket-popup-mobile-halfway', 'ticket-popup-mobile-full');
    popup.classList.add(full ? 'ticket-popup-mobile-full' : 'ticket-popup-mobile-halfway');
    popup.style.height = full ? '100dvh' : '50dvh';
    popup.style.maxHeight = full ? '100dvh' : '50dvh';
}

function syncTicketPopupMobileHeightToggle() {
    const grab = document.getElementById('ticketPopupMobileHeightGrab');
    const popup = document.getElementById('ticketPopup');
    if (!grab || !popup) return;
    if (!isMobileView() || !popup.classList.contains('show')) {
        grab.hidden = true;
        return;
    }
    grab.hidden = false;
    const isFull = popup.classList.contains('ticket-popup-mobile-full');
    const label = isFull ? 'Collapse to half screen' : 'Expand to full screen';
    grab.setAttribute('aria-label', label);
    grab.title = label;
    grab.classList.toggle('ticket-popup-mobile-height-grab--full', isFull);
}

function toggleTicketPopupMobileHeight() {
    const popup = document.getElementById('ticketPopup');
    if (!popup || !isMobileView() || !popup.classList.contains('show')) return;
    const toFull = !popup.classList.contains('ticket-popup-mobile-full');
    applyTicketPopupMobileHeight(popup, toFull ? 'full' : 'half');
    syncTicketPopupMobileHeightToggle();
}

(function initTicketPopupMobileHeightGrab() {
    const grab = document.getElementById('ticketPopupMobileHeightGrab');
    if (!grab || grab.dataset.bound) return;
    grab.dataset.bound = '1';
    grab.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleTicketPopupMobileHeight();
    });
})();

function initTicketPopupExpandableSections() {
    const content = document.getElementById('ticketPopupContent');
    if (!content) return;

    content.querySelectorAll('[data-ticket-popup-collapsible]').forEach(section => {
        const toggle = section.querySelector('[data-ticket-popup-collapse-toggle]');
        if (!toggle || toggle.dataset.ticketCollapseInit) return;
        toggle.dataset.ticketCollapseInit = '1';
        toggle.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            section.classList.toggle('collapsed');
            toggle.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
        });
    });

    if (!isMobileView()) return;

    // Mobile-only expandable sections that are not already wired above, e.g. Ticket History.
    content.querySelectorAll('.ticket-popup-section.mobile-expandable:not([data-ticket-popup-collapsible])').forEach(section => {
        const title = section.querySelector('.ticket-section-title');
        if (!title || title.dataset.ticketCollapseInit) return;
        title.dataset.ticketCollapseInit = '1';
        title.setAttribute('role', 'button');
        title.setAttribute('aria-expanded', 'true');
        title.classList.add('ticket-mobile-section-toggle');
        title.addEventListener('click', function () {
            section.classList.toggle('collapsed');
            title.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
        });
    });

    // Photos expandable block
    content.querySelectorAll('.ticket-mobile-expandable-section').forEach(section => {
        const toggle = section.querySelector('.ticket-mobile-expandable-toggle');
        if (!toggle || toggle.dataset.ticketCollapseInit) return;
        toggle.dataset.ticketCollapseInit = '1';
        toggle.setAttribute('role', 'button');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.addEventListener('click', function () {
            section.classList.toggle('collapsed');
            toggle.setAttribute('aria-expanded', section.classList.contains('collapsed') ? 'false' : 'true');
        });
    });
}

/** Hide the map ticket popup without clearing map/list selection (e.g. Ticket Hub row select). */
function hideTicketPopupKeepSelection() {
    const popup = document.getElementById('ticketPopup');
    if (!popup || !popup.classList.contains('show')) return;
    closeTicketPopupMockPreviewModal();
    removeTicketPopupViewportRefreshLock(popup);
    popup.classList.remove('show');
    popup.classList.remove('ticket-popup-mobile-halfway', 'ticket-popup-mobile-full');
    popup.classList.remove('ticket-popup--above-hub');
    popup.classList.remove('ticket-popup--refresh-busy');
    popup.removeAttribute('data-popup-ticket-id');
    if (typeof syncTicketPopupHeaderUpdatingIndicator === 'function') {
        syncTicketPopupHeaderUpdatingIndicator();
    }
    popup.style.height = '';
    popup.style.maxHeight = '';
    syncTicketPopupMobileHeightToggle();
}

// Close ticket popup
function closeTicketPopup() {
    closeTicketPopupMockPreviewModal();
    const popup = document.getElementById('ticketPopup');
    if (popup) {
        removeTicketPopupViewportRefreshLock(popup);
        popup.classList.remove('show');
        popup.classList.remove('ticket-popup-mobile-halfway', 'ticket-popup-mobile-full');
        popup.classList.remove('ticket-popup--above-hub');
        popup.classList.remove('ticket-popup--refresh-busy');
        popup.removeAttribute('data-popup-ticket-id');
        clearTicketPopupHeaderStatusBadge(popup);
        if (typeof syncTicketPopupHeaderUpdatingIndicator === 'function') {
            syncTicketPopupHeaderUpdatingIndicator();
        }
        popup.style.height = '';
        popup.style.maxHeight = '';
        syncTicketPopupMobileHeightToggle();
        selectedTicketId = null;
        renderTickets();
        renderTicketList(); // Update ticket list to remove selection
    }
}

// Ticket list panel removed — open Ticket Hub instead.
function toggleTicketList() {
    if (typeof window.openTicketHubWindow === 'function') {
        void window.openTicketHubWindow();
    }
}

// Export toggleTicketList immediately after definition to ensure it's available
window.toggleTicketList = toggleTicketList;

// Apply default ticket status from user profile to the ticket list filter (dropdown + internal state).
// Called on app load and when saving settings so the filter reflects the user's preference.
function applyDefaultTicketStatusFromProfile() {
    const profile = typeof window.getUserProfile === 'function' ? window.getUserProfile() : (window.userPreferences || {});
    const defaultStatus = normalizeSidebarTicketStatusFilter(profile.defaultTicketStatus || 'ACTIVE');
    ticketListStatusFilter = defaultStatus;
    renderTicketList();
    if (typeof window.renderTickets === 'function') window.renderTickets();
}
window.toggleTicketPopupMobileHeight = toggleTicketPopupMobileHeight;
window.syncTicketPopupMobileHeightToggle = syncTicketPopupMobileHeightToggle;
window.applyTicketPopupMobileHeight = applyTicketPopupMobileHeight;
window.applyDefaultTicketStatusFromProfile = applyDefaultTicketStatusFromProfile;
window.normalizeSidebarTicketStatusFilter = normalizeSidebarTicketStatusFilter;
window.resetSidebarTicketListFiltersForOrgSwitch = resetSidebarTicketListFiltersForOrgSwitch;

