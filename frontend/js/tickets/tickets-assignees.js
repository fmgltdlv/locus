/**
 * tickets-assignees.js — split from tickets-popup-assignees.js (Phase F2).
 * Ticket assignees modal, dirty checklist, PATCH save.
 * Globals: same window/function names as before (IIFE bundle).
 */
/** Sorted JSON array of selected user id strings when the editor opened (for dirty detection). */
let ticketAssigneesModalBaselineSignature = null;
/** When true, close modal without prompting about unsaved edits (after successful save). */
let ticketAssigneesModalSkipDirtyOnClose = false;

function getTicketAssigneesChecklistSignature(container) {
    if (!container) return '[]';
    const ids = Array.from(container.querySelectorAll('input[type="checkbox"]'))
        .filter((cb) => cb.checked)
        .map((cb) => String(cb.dataset.userId))
        .sort();
    return JSON.stringify(ids);
}

function isTicketAssigneesModalDirty() {
    const container = document.getElementById('ticketAssigneesModalChecklist');
    if (!container || ticketAssigneesModalBaselineSignature == null) return false;
    return getTicketAssigneesChecklistSignature(container) !== ticketAssigneesModalBaselineSignature;
}

function syncTicketAssigneesSaveButton() {
    const saveBtn = document.getElementById('ticketAssigneesModalSaveBtn');
    if (!saveBtn) return;
    saveBtn.disabled = !isTicketAssigneesModalDirty();
}

function refreshAssigneeCountInMainUi(ticketNumber) {
    const tickets = window.ORG_TICKETS || [];
    const ticket = tickets.find(t => String(t.ticketNumber) === String(ticketNumber));
    if (ticket && ticketIdEquals(selectedTicketId, ticket.id) && typeof showTicketPopup === 'function') {
        showTicketPopup(ticket);
    }
    if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
        window.ticketHubModule.redrawIfOpen();
    }
    renderTicketList();
    renderTickets();
}

async function closeTicketAssigneesModal() {
    if (!ticketAssigneesModalSkipDirtyOnClose) {
        const editor = document.getElementById('ticketAssigneesModalEditor');
        if (editor && editor.style.display !== 'none' && isTicketAssigneesModalDirty()) {
            let discard = false;
            if (typeof window.appConfirm === 'function') {
                discard = await window.appConfirm('Discard unsaved assignment changes?');
            } else {
                discard = window.confirm('Discard unsaved assignment changes?');
            }
            if (!discard) return;
        }
    }
    ticketAssigneesModalSkipDirtyOnClose = false;
    ticketAssigneesModalBaselineSignature = null;
    const closedFor = ticketAssigneesModalTicketNumber;
    ticketAssigneesModalTicketNumber = null;
    const modal = document.getElementById('ticketAssigneesModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
    const checklist = document.getElementById('ticketAssigneesModalChecklist');
    if (checklist) {
        checklist.innerHTML = '';
        checklist.onchange = null;
    }
    const saveBtn = document.getElementById('ticketAssigneesModalSaveBtn');
    if (saveBtn) saveBtn.disabled = true;
    if (closedFor != null) {
        refreshAssigneeCountInMainUi(closedFor);
    }
}

function renderTicketAssigneesModalReadOnlyList(ticket) {
    const listEl = document.getElementById('ticketAssigneesModalList');
    if (!listEl) return;
    listEl.innerHTML = '';
    const users = getTicketAssignedUsers(ticket);
    if (users.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ticket-assignees-empty';
        empty.textContent = 'No one assigned';
        listEl.appendChild(empty);
        return;
    }
    users.forEach(a => {
        const row = document.createElement('label');
        row.className = 'ticket-assignee-checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.disabled = true;
        cb.setAttribute('aria-checked', 'true');
        const span = document.createElement('span');
        span.className = 'ticket-assignee-checkbox-label';
        const label = (a.userName && String(a.userName).trim()) ? String(a.userName) : `User #${a.userId}`;
        span.textContent = label;
        row.appendChild(cb);
        row.appendChild(span);
        listEl.appendChild(row);
    });
}

function openTicketAssigneesModal(ticketNumber) {
    const tickets = window.ORG_TICKETS || [];
    const ticket = tickets.find(t => String(t.ticketNumber) === String(ticketNumber));
    if (!ticket) return;
    ticketAssigneesModalTicketNumber = ticket.ticketNumber;
    const refEl = document.getElementById('ticketAssigneesModalTicketRef');
    if (refEl) refEl.textContent = `Ticket #${ticket.ticketNumber}`;
    const canAssign = window.authModule && (window.authModule.isAdmin() || window.authModule.isDev());
    const readOnly = document.getElementById('ticketAssigneesModalReadOnly');
    const editor = document.getElementById('ticketAssigneesModalEditor');
    if (canAssign) {
        if (readOnly) readOnly.style.display = 'none';
        if (editor) editor.style.display = 'block';
        populateTicketAssigneesModalChecklist(ticket);
    } else {
        if (readOnly) readOnly.style.display = 'block';
        if (editor) editor.style.display = 'none';
        renderTicketAssigneesModalReadOnlyList(ticket);
    }
    const modal = document.getElementById('ticketAssigneesModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('show');
    }
}

function refreshTicketAssigneesModalIfOpen(ticketNumber) {
    if (ticketAssigneesModalTicketNumber == null || String(ticketAssigneesModalTicketNumber) !== String(ticketNumber)) {
        return;
    }
    const tickets = window.ORG_TICKETS || [];
    const ticket = tickets.find(t => String(t.ticketNumber) === String(ticketNumber));
    if (!ticket) return;
    const modal = document.getElementById('ticketAssigneesModal');
    if (!modal || !modal.classList.contains('show')) return;
    const canAssign = window.authModule && (window.authModule.isAdmin() || window.authModule.isDev());
    if (canAssign) {
        populateTicketAssigneesModalChecklist(ticket);
    } else {
        renderTicketAssigneesModalReadOnlyList(ticket);
    }
}

// Populate assignee checklist in modal (admin/dev) - checked = assigned
async function populateTicketAssigneesModalChecklist(ticket) {
    const container = document.getElementById('ticketAssigneesModalChecklist');
    if (!container || !ticket) return;
    const orgId = window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
        ? window.orgSelectorModule.getCurrentOrgId()
        : (window.authModule && window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId);
    if (!orgId || !window.authModule) return;
    const currentValues = new Set(getTicketAssignedUsers(ticket).map(a => String(a.userId)));
    container.innerHTML = '';
    container.onchange = null;
    try {
        const users = await window.authModule.apiRequest(`${window.authModule.API_BASE}/users?organizationId=${orgId}`);
        const list = Array.isArray(users) ? users : [];
        list.forEach(u => {
            const displayName = u.full_name || u.username || `User ${u.id}`;
            const row = document.createElement('label');
            row.className = 'ticket-assignee-checkbox-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.userId = String(u.id);
            cb.dataset.userName = displayName;
            cb.checked = currentValues.has(String(u.id));
            const span = document.createElement('span');
            span.className = 'ticket-assignee-checkbox-label';
            span.textContent = displayName;
            row.appendChild(cb);
            row.appendChild(span);
            container.appendChild(row);
        });
    } catch (err) {
        console.error('Error loading org users for assignee modal:', err);
    }
    ticketAssigneesModalBaselineSignature = getTicketAssigneesChecklistSignature(container);
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', syncTicketAssigneesSaveButton);
    });
    syncTicketAssigneesSaveButton();
}

function setTicketAssigneesModalSaving(saving) {
    const modal = document.getElementById('ticketAssigneesModal');
    const saveBtn = document.getElementById('ticketAssigneesModalSaveBtn');
    const cancelBtn = document.getElementById('ticketAssigneesModalCancelBtn');
    const checklist = document.getElementById('ticketAssigneesModalChecklist');
    if (modal) {
        modal.setAttribute('aria-busy', saving ? 'true' : 'false');
    }
    if (cancelBtn) {
        cancelBtn.disabled = saving;
    }
    if (checklist) {
        checklist.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.disabled = saving;
        });
    }
    if (saveBtn) {
        if (saving) {
            if (!saveBtn.dataset._assignSaveHtml) {
                saveBtn.dataset._assignSaveHtml = saveBtn.innerHTML;
            }
            saveBtn.disabled = true;
            saveBtn.setAttribute('aria-busy', 'true');
            saveBtn.innerHTML =
                '<span class="ticket-action-btn-spinner" aria-hidden="true"></span> ' +
                '<span>Saving...</span>';
        } else {
            saveBtn.removeAttribute('aria-busy');
            if (saveBtn.dataset._assignSaveHtml) {
                saveBtn.innerHTML = saveBtn.dataset._assignSaveHtml;
                delete saveBtn.dataset._assignSaveHtml;
            }
        }
    }
}

/** Called from Save in assignees modal - one PATCH with current checklist selection. */
async function submitTicketAssigneesModalSave() {
    const tn = ticketAssigneesModalTicketNumber;
    if (!tn || !isTicketAssigneesModalDirty()) return;
    const container = document.getElementById('ticketAssigneesModalChecklist');
    if (!container) return;
    const assignedToUsers = Array.from(container.querySelectorAll('input[type="checkbox"]'))
        .filter((cb) => cb.checked)
        .map((cb) => ({
            userId: parseInt(cb.dataset.userId, 10),
            userName: cb.dataset.userName || null
        }))
        .filter((a) => !Number.isNaN(a.userId));
    setTicketAssigneesModalSaving(true);
    try {
        await updateTicketAssignment(tn, assignedToUsers, { closeAssigneesModal: true });
    } finally {
        setTicketAssigneesModalSaving(false);
        const modal = document.getElementById('ticketAssigneesModal');
        if (modal && modal.classList.contains('show')) {
            syncTicketAssigneesSaveButton();
        }
    }
}

// Update ticket assignment via PATCH and refresh local ticket
async function updateTicketAssignment(ticketNumber, assignedToUsers, options) {
    if (!window.authModule) return;
    if (window.offlineModule && window.offlineModule.guardOfflineAction && window.offlineModule.guardOfflineAction('Assignment changes require an internet connection.')) {
        return;
    }
    try {
        const orgId = window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
            ? window.orgSelectorModule.getCurrentOrgId()
            : (window.authModule.getCurrentUser() && window.authModule.getCurrentUser().organizationId);
        const normalizedAssignees = Array.isArray(assignedToUsers) ? assignedToUsers : [];
        const body = { assignedToUsers: normalizedAssignees };
        const firstAssignee = normalizedAssignees.length > 0 ? normalizedAssignees[0] : null;
        body.assignedToUserId = firstAssignee ? firstAssignee.userId : null;
        body.assignedToUserName = firstAssignee ? firstAssignee.userName : null;
        if (orgId != null) body.organizationId = orgId;
        const updated = await window.authModule.apiRequest(
            `${window.authModule.API_BASE}/tickets/${encodeURIComponent(ticketNumber)}`,
            { method: 'PATCH', body: JSON.stringify(body) }
        );
        const tickets = window.ORG_TICKETS || [];
        const idx = tickets.findIndex(t => String(t.ticketNumber) === String(ticketNumber));
        if (idx >= 0) {
            tickets[idx] = mergeTicketFromServerPatch(tickets[idx], updated);
            if (ticketIdEquals(selectedTicketId, tickets[idx].id) && typeof showTicketPopup === 'function') {
                showTicketPopup(tickets[idx]);
            }
        }
        if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
            window.ticketHubModule.redrawIfOpen();
        }
        renderTicketList();
        renderTickets();
        if (options && options.closeAssigneesModal) {
            ticketAssigneesModalSkipDirtyOnClose = true;
            await closeTicketAssigneesModal();
        } else {
            refreshTicketAssigneesModalIfOpen(ticketNumber);
        }
    } catch (err) {
        console.error('Error updating ticket assignment:', err);
        await appAlert('Failed to update assignment.');
        syncTicketAssigneesSaveButton();
    }
}
