'use strict';

const TICKET_NOTE_BODY_MAX = 4000;

function ticketNotesReadOnlyForTicket(ticket) {
    if (!ticket) return true;
    if (typeof isHubTicketExternalForOrg === 'function' && isHubTicketExternalForOrg(ticket)) {
        return true;
    }
    if (
        window.ticketsModule &&
        typeof window.ticketsModule.isTicketExternalForOrg === 'function' &&
        window.ticketsModule.isTicketExternalForOrg(ticket)
    ) {
        return true;
    }
    return !!(ticket && ticket.shared);
}

function ticketNotesApiBase(ticket) {
    const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    if (!tn) return null;
    const base =
        window.authModule && window.authModule.API_BASE ? String(window.authModule.API_BASE) : '/api';
    let orgId = null;
    if (ticket && ticket.organizationId != null && ticket.organizationId !== '') {
        const n = parseInt(String(ticket.organizationId), 10);
        if (Number.isFinite(n)) orgId = n;
    }
    if (orgId == null && window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        orgId = window.orgSelectorModule.getCurrentOrgId();
    } else if (orgId == null && window.authModule && window.authModule.getCurrentUser) {
        const u = window.authModule.getCurrentUser();
        orgId = u && u.organizationId;
    }
    const q = orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : '';
    return { tn, base, q, orgId };
}

/** @type {Map<string, Promise<boolean>>} */
const notesReviewStatusPromises = new Map();
/** @type {Map<string, number>} */
const notesReviewStatusFetchedAt = new Map();
const NOTES_REVIEW_STATUS_TTL_MS = 30000;

async function fetchTicketNotesReviewStatus(ticket) {
    if (!ticket) return false;
    const api = ticketNotesApiBase(ticket);
    if (!api || !window.authModule || !window.authModule.apiRequest) {
        ticket.notesReviewRequired = false;
        return false;
    }
    const tn = api.tn;
    const fetchedAt = notesReviewStatusFetchedAt.get(tn);
    if (fetchedAt && Date.now() - fetchedAt < NOTES_REVIEW_STATUS_TTL_MS) {
        return !!ticket.notesReviewRequired;
    }
    if (notesReviewStatusPromises.has(tn)) {
        return notesReviewStatusPromises.get(tn);
    }
    const promise = (async () => {
        try {
            const data = await window.authModule.apiRequest(
                `${api.base}/tickets/${encodeURIComponent(api.tn)}/notes/status${api.q}`
            );
            ticket.notesReviewRequired = !!(data && data.reviewRequired);
            notesReviewStatusFetchedAt.set(tn, Date.now());
            return ticket.notesReviewRequired;
        } catch (_e) {
            ticket.notesReviewRequired = false;
            return false;
        } finally {
            notesReviewStatusPromises.delete(tn);
        }
    })();
    notesReviewStatusPromises.set(tn, promise);
    return promise;
}

function escapeTicketNoteHtml(s) {
    if (typeof hubEscapeHtml === 'function') return hubEscapeHtml(s);
    if (typeof escapeHtmlTicketUi === 'function') return escapeHtmlTicketUi(s);
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatTicketNoteDate(iso) {
    if (typeof window.formatRecordedDateTime === 'function') {
        return window.formatRecordedDateTime(iso, '', String(iso || ''));
    }
    return iso ? String(iso) : '';
}

function buildTicketNotesPanelShellHtml(ticket, opts) {
    const readOnly = (opts && opts.readOnly) || ticketNotesReadOnlyForTicket(ticket);
    const listId = 'ticketNotesList';
    if (readOnly) {
        return `<div class="ticket-notes-panel ticket-notes-panel--readonly">
            <p class="ticket-notes-readonly-hint">Notes are managed by the ticket owner organization.</p>
            <div class="ticket-notes-list" id="${listId}" aria-live="polite"></div>
        </div>`;
    }
    return `<div class="ticket-notes-panel">
        <form class="ticket-notes-compose" data-ticket-notes-compose>
            <label class="ticket-notes-compose-label" for="ticketNotesBodyInput">Add a note</label>
            <textarea id="ticketNotesBodyInput" class="ticket-notes-compose-input" name="body" rows="3" maxlength="${TICKET_NOTE_BODY_MAX}" placeholder="Write a note for your team…"></textarea>
            <div class="ticket-notes-compose-actions">
                <button type="submit" class="ticket-hub-action-btn ticket-hub-action-primary ticket-notes-save-btn">Save note</button>
            </div>
        </form>
        <div class="ticket-notes-list" id="${listId}" aria-live="polite"></div>
    </div>`;
}

function renderTicketNotesList(container, notes) {
    const listEl = container.querySelector('.ticket-notes-list');
    if (!listEl) return;
    const rows = Array.isArray(notes) ? notes : [];
    if (!rows.length) {
        listEl.innerHTML = '<p class="ticket-notes-empty">No notes yet.</p>';
        return;
    }
    listEl.innerHTML = rows
        .map((n) => {
            const author = n.userName != null && String(n.userName).trim() !== '' ? String(n.userName).trim() : 'Unknown';
            const when = formatTicketNoteDate(n.createdAt);
            const body = escapeTicketNoteHtml(n.body != null ? String(n.body) : '');
            return `<article class="ticket-notes-card${n.pendingSync ? ' ticket-notes-card--pending' : ''}">
                <header class="ticket-notes-card-header">
                    <span class="ticket-notes-card-author">${escapeTicketNoteHtml(author)}</span>
                    <time class="ticket-notes-card-time" datetime="${escapeTicketNoteHtml(n.createdAt || '')}">${escapeTicketNoteHtml(when)}</time>
                </header>
                <div class="ticket-notes-card-body">${body.replace(/\n/g, '<br>')}${n.pendingSync ? '<div class="ticket-notes-pending-label">Pending sync</div>' : ''}</div>
            </article>`;
        })
        .join('');
}

async function loadTicketNotesForPanel(ticket, container) {
    if (!container || !ticket) return;
    const api = ticketNotesApiBase(ticket);
    const listEl = container.querySelector('.ticket-notes-list');
    if (listEl) {
        listEl.innerHTML = '<p class="ticket-notes-loading">Loading notes…</p>';
    }
    const offline = window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline();
    if (offline && window.offlineNotes) {
        const orgId = api && api.orgId;
        const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        const cached = await window.offlineNotes.getCachedTicketNotes(orgId, tn);
        const pending = await window.offlineNotes.listPendingNotesForTicket(orgId, tn);
        const rows = (cached && Array.isArray(cached.notes) ? cached.notes.slice() : []).concat(
            pending.map((p) => window.offlineNotes.pendingNoteToDisplayRow(p, p.clientNoteId))
        );
        renderTicketNotesList(container, rows);
        return;
    }
    if (!api || !window.authModule || !window.authModule.apiRequest) {
        if (listEl) listEl.innerHTML = '<p class="ticket-notes-empty">Notes unavailable for this ticket.</p>';
        return;
    }
    try {
        const data = await window.authModule.apiRequest(
            `${api.base}/tickets/${encodeURIComponent(api.tn)}/notes${api.q}`
        );
        renderTicketNotesList(container, data && data.notes);
        if (window.offlineNotes) {
            await window.offlineNotes.cacheTicketNotes(api.orgId, api.tn, data && data.notes, data && data.reviewRequired);
        }
        ticket.notesReviewRequired = !!(data && data.reviewRequired);
        if (!offline) {
            await window.authModule.apiRequest(
                `${api.base}/tickets/${encodeURIComponent(api.tn)}/notes/mark-read`,
                { method: 'POST', body: JSON.stringify({ organizationId: api.orgId }) }
            );
        }
        ticket.notesReviewRequired = false;
        const root = container.closest('.ticket-hub-detail-body-wrap') || container.closest('.ticket-popup-content') || container;
        if (typeof window.updateTicketDetailTabDot === 'function') {
            const notesDotStatus = ticket.notesReviewRequired ? 'action-required' : null;
            window.updateTicketDetailTabDot(root, 'notes', notesDotStatus);
        }
    } catch (_e) {
        if (listEl) {
            listEl.innerHTML = '<p class="ticket-notes-empty">Could not load notes.</p>';
        }
    }
}

function wireTicketNotesPanel(container, ticket) {
    if (!container || !ticket) return;
    const form = container.querySelector('[data-ticket-notes-compose]');
    if (!form || form.dataset.ticketNotesComposeInit === '1') return;
    if (ticketNotesReadOnlyForTicket(ticket)) return;
    form.dataset.ticketNotesComposeInit = '1';
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const textarea = form.querySelector('textarea');
        const btn = form.querySelector('.ticket-notes-save-btn');
        const body = textarea && textarea.value != null ? String(textarea.value).trim() : '';
        if (!body) return;
        const api = ticketNotesApiBase(ticket);
        if (!api) return;
        if (window.offlineModule && window.offlineModule.isOnline && !window.offlineModule.isOnline()) {
            if (window.offlineNotes) {
                const queued = await window.offlineNotes.enqueuePendingNote(ticket, body);
                if (queued) {
                    if (textarea) textarea.value = '';
                    const pending = await window.offlineNotes.listPendingNotesForTicket(api.orgId, api.tn);
                    const cached = await window.offlineNotes.getCachedTicketNotes(api.orgId, api.tn);
                    const rows = (cached && Array.isArray(cached.notes) ? cached.notes.slice() : []).concat(
                        pending.map((p) => window.offlineNotes.pendingNoteToDisplayRow(p, p.clientNoteId))
                    );
                    renderTicketNotesList(container, rows);
                }
            }
            return;
        }
        if (!window.authModule || !window.authModule.apiRequest) return;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving…';
        }
        try {
            await window.authModule.apiRequest(
                `${api.base}/tickets/${encodeURIComponent(api.tn)}/notes`,
                { method: 'POST', body: JSON.stringify({ body, organizationId: api.orgId }) }
            );
            if (textarea) textarea.value = '';
            await loadTicketNotesForPanel(ticket, container);
        } catch (err) {
            if (typeof window.appAlert === 'function') {
                void window.appAlert(err && err.message ? err.message : 'Failed to save note.');
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Save note';
            }
        }
    });
}

window.fetchTicketNotesReviewStatus = fetchTicketNotesReviewStatus;
window.buildTicketNotesPanelShellHtml = buildTicketNotesPanelShellHtml;
window.loadTicketNotesForPanel = loadTicketNotesForPanel;
window.wireTicketNotesPanel = wireTicketNotesPanel;
window.ticketNotesReadOnlyForTicket = ticketNotesReadOnlyForTicket;
