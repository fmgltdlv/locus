'use strict';

let ticketProjectsModalTicketNumber = null;
let ticketProjectsModalBaselineSignature = null;
let ticketProjectsModalSkipDirtyOnClose = false;
let ticketProjectsOpenProjectsCache = null;
/** @type {Promise<object[]>|null} */
let ticketProjectsOpenProjectsFetchPromise = null;

function ticketProjectMembershipApiBase(ticket) {
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
    const tn =
        ticket && ticket.ticketNumber != null
            ? String(ticket.ticketNumber).trim()
            : ticket && ticket.id != null
              ? String(ticket.id)
              : '';
    const q = orgId != null ? `?organizationId=${encodeURIComponent(orgId)}` : '';
    return { base, orgId, tn, q };
}

function escapeTicketProjectHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function ticketProjectMembershipReadOnly(ticket) {
    if (!ticket) return true;
    if (ticket.shared || ticket.readOnly) return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (!window.authModule || !window.authModule.isAuthenticated()) return true;
    return false;
}

function formatTicketProjectsLabel(projects) {
    const list = Array.isArray(projects) ? projects : [];
    if (!list.length) return 'None';
    if (list.length === 1) {
        const name = list[0] && list[0].jobName != null ? String(list[0].jobName).trim() : '';
        return name || '1 project';
    }
    return 'Multiple';
}

function buildTicketProjectsFieldHtml(_ticket) {
    return `<div class="ticket-popup-row" data-ticket-projects-field>
        <span class="ticket-popup-label">Projects:</span>
        <span class="ticket-popup-value">
            <button type="button" id="ticketProjectsBtn" class="ticket-assignee-count-btn ticket-projects-count-btn" title="View or change project membership">…</button>
        </span>
    </div>`;
}

function buildTicketHubProjectsFieldBlockHtml(_ticket) {
    return `<button type="button" id="ticketHubDetailProjectsBtn" class="ticket-hub-assignee-count-btn ticket-projects-count-btn" title="View or change project membership">…</button>`;
}

/** @type {Map<string, Promise<object[]>>} */
const ticketProjectsFetchPromises = new Map();

async function fetchTicketProjects(ticket) {
    const api = ticketProjectMembershipApiBase(ticket);
    if (!api.tn || !window.authModule || !window.authModule.apiRequest) return [];
    const key = api.tn;
    if (ticketProjectsFetchPromises.has(key)) {
        return ticketProjectsFetchPromises.get(key);
    }
    const promise = (async () => {
        try {
            const data = await window.authModule.apiRequest(
                `${api.base}/tickets/${encodeURIComponent(api.tn)}/projects${api.q}`
            );
            return Array.isArray(data && data.projects) ? data.projects : [];
        } finally {
            ticketProjectsFetchPromises.delete(key);
        }
    })();
    ticketProjectsFetchPromises.set(key, promise);
    return promise;
}

async function resolveTicketProjectJobKey(ticket) {
    if (!ticket) return null;
    const projects = await fetchTicketProjects(ticket);
    if (projects.length === 1) {
        return {
            jobNameKey: String(projects[0].jobNameKey || '').trim().toLowerCase(),
            jobName: projects[0].jobName != null ? String(projects[0].jobName).trim() : '',
        };
    }
    if (projects.length > 1) {
        const manual = projects.find((p) => p && p.membershipSource === 'manual');
        const pick = manual || projects[0];
        return {
            jobNameKey: String(pick.jobNameKey || '').trim().toLowerCase(),
            jobName: pick.jobName != null ? String(pick.jobName).trim() : '',
        };
    }
    const jobName =
        typeof window.pickJobNameForCompliance === 'function'
            ? window.pickJobNameForCompliance(ticket)
            : null;
    if (jobName && String(jobName).trim()) {
        const name = String(jobName).trim();
        return { jobNameKey: name.toLowerCase(), jobName: name };
    }
    return null;
}

function shouldShowOpenProjectAction(ticket) {
    return !!(ticket && !ticket.shared);
}

async function openTicketProjectInHub(ticket) {
    if (!shouldShowOpenProjectAction(ticket)) return;
    try {
        const resolved = await resolveTicketProjectJobKey(ticket);
        if (!resolved || !resolved.jobNameKey) {
            if (typeof window.appAlert === 'function') {
                void window.appAlert('No project is linked to this ticket yet.');
            }
            return;
        }
        if (typeof window.closeTicketPopup === 'function') {
            window.closeTicketPopup();
        }
        if (typeof window.openTicketHubToProject === 'function') {
            await window.openTicketHubToProject(resolved.jobNameKey);
            return;
        }
        if (typeof window.appAlert === 'function') {
            void window.appAlert('Ticket Hub is not available.');
        }
    } catch (err) {
        console.error('Open project in hub:', err);
        if (typeof window.appAlert === 'function') {
            void window.appAlert(err && err.message ? err.message : 'Failed to open project.');
        }
    }
}

async function fetchOpenProjectsForPicker() {
    if (ticketProjectsOpenProjectsCache) {
        return ticketProjectsOpenProjectsCache;
    }
    if (ticketProjectsOpenProjectsFetchPromise) {
        return ticketProjectsOpenProjectsFetchPromise;
    }
    const base =
        window.authModule && window.authModule.API_BASE ? String(window.authModule.API_BASE) : '/api';
    let orgId = null;
    if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        orgId = window.orgSelectorModule.getCurrentOrgId();
    }
    const q = orgId != null ? `?organizationId=${encodeURIComponent(orgId)}&status=open` : '?status=open';
    if (!window.authModule || !window.authModule.apiRequest) return [];
    ticketProjectsOpenProjectsFetchPromise = (async () => {
        try {
            const data = await window.authModule.apiRequest(`${base}/tickets/job-projects${q}`);
            const projects = Array.isArray(data && data.projects) ? data.projects : [];
            ticketProjectsOpenProjectsCache = projects;
            return projects;
        } finally {
            ticketProjectsOpenProjectsFetchPromise = null;
        }
    })();
    return ticketProjectsOpenProjectsFetchPromise;
}

function renderTicketProjectsModalLoading(container) {
    if (!container) return;
    container.innerHTML =
        '<div class="ticket-projects-modal-loading" aria-busy="true" role="status">' +
        (typeof window.getAppLoaderHtml === 'function' ? window.getAppLoaderHtml({ decorative: true }) : '<div class="app-loading-indicator" aria-hidden="true"></div>') +
        '<p class="ticket-hub-loading-text">Loading projects…</p>' +
        '</div>';
}

function setTicketProjectsModalLoading(loading) {
    const modal = document.getElementById('ticketProjectsModal');
    const saveBtn = document.getElementById('ticketProjectsModalSaveBtn');
    const cancelBtn = document.getElementById('ticketProjectsModalCancelBtn');
    const createBtn = document.getElementById('ticketProjectsModalCreateBtn');
    const checklist = document.getElementById('ticketProjectsModalChecklist');
    const readOnlyList = document.getElementById('ticketProjectsModalList');
    if (modal) {
        modal.setAttribute('aria-busy', loading ? 'true' : 'false');
    }
    if (cancelBtn) cancelBtn.disabled = loading;
    if (createBtn) createBtn.disabled = loading;
    if (saveBtn) saveBtn.disabled = loading || !isTicketProjectsModalDirty();
    if (loading) {
        if (checklist) renderTicketProjectsModalLoading(checklist);
        if (readOnlyList) renderTicketProjectsModalLoading(readOnlyList);
    }
}

async function loadTicketProjectsField(ticket, btnEl) {
    const btn = btnEl || document.getElementById('ticketProjectsBtn');
    if (!btn || !ticket) return;
    btn.disabled = true;
    btn.textContent = '…';
    try {
        const projects = await fetchTicketProjects(ticket);
        btn.textContent = formatTicketProjectsLabel(projects);
        btn.title =
            projects.length === 1
                ? `Project: ${projects[0].jobName || projects[0].jobNameKey}`
                : 'View or change project membership';
    } catch (_e) {
        btn.textContent = 'Unavailable';
        btn.title = 'Projects unavailable';
    } finally {
        btn.disabled = false;
    }
}

async function addTicketToProject(ticket, jobNameKey) {
    const api = ticketProjectMembershipApiBase(ticket);
    if (!api.tn || !jobNameKey) return;
    await window.authModule.apiRequest(
        `${api.base}/tickets/${encodeURIComponent(api.tn)}/projects${api.q}`,
        {
            method: 'POST',
            body: JSON.stringify({ organizationId: api.orgId, jobNameKey }),
        }
    );
}

async function removeTicketFromProject(ticket, jobNameKey, membershipSource) {
    const api = ticketProjectMembershipApiBase(ticket);
    if (!api.tn || !jobNameKey) return;
    const mode = membershipSource === 'manual_include' ? 'revert' : 'exclude';
    await window.authModule.apiRequest(
        `${api.base}/tickets/${encodeURIComponent(api.tn)}/projects/${encodeURIComponent(jobNameKey)}${api.q}`,
        {
            method: 'DELETE',
            body: JSON.stringify({ organizationId: api.orgId, mode }),
        }
    );
}

function getTicketProjectsChecklistSignature(container) {
    if (!container) return '[]';
    const keys = Array.from(container.querySelectorAll('input[type="checkbox"]'))
        .filter((cb) => cb.checked)
        .map((cb) => String(cb.dataset.jobNameKey || ''))
        .filter(Boolean)
        .sort();
    return JSON.stringify(keys);
}

function isTicketProjectsModalDirty() {
    const container = document.getElementById('ticketProjectsModalChecklist');
    if (!container || ticketProjectsModalBaselineSignature == null) return false;
    return getTicketProjectsChecklistSignature(container) !== ticketProjectsModalBaselineSignature;
}

function syncTicketProjectsSaveButton() {
    const saveBtn = document.getElementById('ticketProjectsModalSaveBtn');
    if (!saveBtn) return;
    saveBtn.disabled = !isTicketProjectsModalDirty();
}

function refreshTicketProjectsFieldsForTicket(ticketNumber) {
    const tickets = window.ORG_TICKETS || [];
    const ticket = tickets.find((t) => String(t.ticketNumber) === String(ticketNumber));
    if (!ticket) return;
    void loadTicketProjectsField(ticket);
    const hubBtn = document.getElementById('ticketHubDetailProjectsBtn');
    if (hubBtn) void loadTicketProjectsField(ticket, hubBtn);
    if (typeof window.refreshComplianceHubStatusForTicket === 'function') {
        void window.refreshComplianceHubStatusForTicket(ticket);
    }
}

async function closeTicketProjectsModal() {
    if (!ticketProjectsModalSkipDirtyOnClose) {
        const editor = document.getElementById('ticketProjectsModalEditor');
        if (editor && editor.style.display !== 'none' && isTicketProjectsModalDirty()) {
            let discard = false;
            if (typeof window.appConfirm === 'function') {
                discard = await window.appConfirm('Discard unsaved project changes?');
            } else {
                discard = window.confirm('Discard unsaved project changes?');
            }
            if (!discard) return;
        }
    }
    ticketProjectsModalSkipDirtyOnClose = false;
    ticketProjectsModalBaselineSignature = null;
    const closedFor = ticketProjectsModalTicketNumber;
    ticketProjectsModalTicketNumber = null;
    const modal = document.getElementById('ticketProjectsModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
    }
    const checklist = document.getElementById('ticketProjectsModalChecklist');
    if (checklist) {
        checklist.innerHTML = '';
        checklist.onchange = null;
    }
    const saveBtn = document.getElementById('ticketProjectsModalSaveBtn');
    if (saveBtn) saveBtn.disabled = true;
    if (closedFor != null) {
        refreshTicketProjectsFieldsForTicket(closedFor);
    }
}

function renderTicketProjectsModalReadOnlyList(projects) {
    const listEl = document.getElementById('ticketProjectsModalList');
    if (!listEl) return;
    listEl.innerHTML = '';
    const list = Array.isArray(projects) ? projects : [];
    if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'ticket-assignees-empty';
        empty.textContent = 'Not in any project';
        listEl.appendChild(empty);
        return;
    }
    list.forEach((p) => {
        const row = document.createElement('label');
        row.className = 'ticket-assignee-checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.disabled = true;
        cb.setAttribute('aria-checked', 'true');
        const span = document.createElement('span');
        span.className = 'ticket-assignee-checkbox-label';
        const name = p.jobName != null ? String(p.jobName).trim() : p.jobNameKey || 'Project';
        span.textContent = p.status === 'closed' ? `${name} (closed)` : name;
        row.appendChild(cb);
        row.appendChild(span);
        listEl.appendChild(row);
    });
}

function mergeProjectsForModalChecklist(openProjects, currentProjects) {
    const byKey = new Map();
    (openProjects || []).forEach((p) => {
        if (!p || !p.jobNameKey) return;
        byKey.set(String(p.jobNameKey), {
            jobNameKey: String(p.jobNameKey),
            jobName: p.jobName != null ? String(p.jobName) : String(p.jobNameKey),
            status: p.status != null ? String(p.status) : 'open',
        });
    });
    (currentProjects || []).forEach((p) => {
        if (!p || !p.jobNameKey) return;
        const key = String(p.jobNameKey);
        if (!byKey.has(key)) {
            byKey.set(key, {
                jobNameKey: key,
                jobName: p.jobName != null ? String(p.jobName) : key,
                status: p.status != null ? String(p.status) : 'open',
            });
        }
    });
    return Array.from(byKey.values()).sort((a, b) =>
        a.jobName.localeCompare(b.jobName, undefined, { sensitivity: 'base' })
    );
}

async function populateTicketProjectsModalChecklist(ticket) {
    const container = document.getElementById('ticketProjectsModalChecklist');
    if (!container || !ticket) return;
    container.innerHTML = '';
    container.onchange = null;
    renderTicketProjectsModalLoading(container);
    try {
        const [current, openProjects] = await Promise.all([
            fetchTicketProjects(ticket),
            fetchOpenProjectsForPicker(),
        ]);
        const merged = mergeProjectsForModalChecklist(openProjects, current);
        container.innerHTML = '';
        const currentByKey = new Map((current || []).map((p) => [String(p.jobNameKey), p]));
        merged.forEach((p) => {
            const key = p.jobNameKey;
            const cur = currentByKey.get(key);
            const isClosed = String(p.status).toLowerCase() === 'closed';
            const row = document.createElement('label');
            row.className = 'ticket-assignee-checkbox-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.jobNameKey = key;
            cb.dataset.jobName = p.jobName;
            cb.dataset.membershipSource =
                cur && cur.membershipSource != null ? String(cur.membershipSource) : '';
            cb.checked = !!cur;
            cb.disabled = isClosed;
            const span = document.createElement('span');
            span.className = 'ticket-assignee-checkbox-label';
            span.textContent = isClosed ? `${p.jobName} (closed)` : p.jobName;
            row.appendChild(cb);
            row.appendChild(span);
            container.appendChild(row);
        });
    } catch (err) {
        console.error('Error loading projects for modal:', err);
        container.innerHTML = '';
        const errEl = document.createElement('div');
        errEl.className = 'ticket-assignees-empty';
        errEl.textContent = 'Could not load projects';
        container.appendChild(errEl);
    }
    ticketProjectsModalBaselineSignature = getTicketProjectsChecklistSignature(container);
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', syncTicketProjectsSaveButton);
    });
    syncTicketProjectsSaveButton();
}

function setTicketProjectsModalSaving(saving) {
    const modal = document.getElementById('ticketProjectsModal');
    const saveBtn = document.getElementById('ticketProjectsModalSaveBtn');
    const cancelBtn = document.getElementById('ticketProjectsModalCancelBtn');
    const createBtn = document.getElementById('ticketProjectsModalCreateBtn');
    const checklist = document.getElementById('ticketProjectsModalChecklist');
    if (modal) {
        modal.setAttribute('aria-busy', saving ? 'true' : 'false');
    }
    if (cancelBtn) cancelBtn.disabled = saving;
    if (createBtn) createBtn.disabled = saving;
    if (checklist) {
        checklist.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            if (!cb.disabled) cb.disabled = saving;
        });
    }
    if (saveBtn) {
        if (saving) {
            if (!saveBtn.dataset._projectsSaveHtml) {
                saveBtn.dataset._projectsSaveHtml = saveBtn.innerHTML;
            }
            saveBtn.disabled = true;
            saveBtn.setAttribute('aria-busy', 'true');
            saveBtn.innerHTML =
                '<span class="ticket-action-btn-spinner" aria-hidden="true"></span> ' + '<span>Saving...</span>';
        } else {
            saveBtn.removeAttribute('aria-busy');
            if (saveBtn.dataset._projectsSaveHtml) {
                saveBtn.innerHTML = saveBtn.dataset._projectsSaveHtml;
                delete saveBtn.dataset._projectsSaveHtml;
            }
        }
    }
}

async function openTicketProjectsModal(ticketNumber) {
    const tickets = window.ORG_TICKETS || [];
    const ticket = tickets.find((t) => String(t.ticketNumber) === String(ticketNumber));
    if (!ticket) return;
    ticketProjectsModalTicketNumber = ticket.ticketNumber;
    ticketProjectsOpenProjectsCache = null;
    const refEl = document.getElementById('ticketProjectsModalTicketRef');
    if (refEl) refEl.textContent = `Ticket #${ticket.ticketNumber}`;
    const readOnly = ticketProjectMembershipReadOnly(ticket);
    const readOnlyEl = document.getElementById('ticketProjectsModalReadOnly');
    const editor = document.getElementById('ticketProjectsModalEditor');
    if (readOnly) {
        if (readOnlyEl) readOnlyEl.style.display = 'block';
        if (editor) editor.style.display = 'none';
    } else {
        if (readOnlyEl) readOnlyEl.style.display = 'none';
        if (editor) editor.style.display = 'block';
    }
    const modal = document.getElementById('ticketProjectsModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('show');
    }
    setTicketProjectsModalLoading(true);
    try {
        if (readOnly) {
            try {
                const projects = await fetchTicketProjects(ticket);
                const listEl = document.getElementById('ticketProjectsModalList');
                if (listEl) listEl.innerHTML = '';
                renderTicketProjectsModalReadOnlyList(projects);
            } catch (_e) {
                const listEl = document.getElementById('ticketProjectsModalList');
                if (listEl) listEl.innerHTML = '';
                renderTicketProjectsModalReadOnlyList([]);
            }
        } else {
            await populateTicketProjectsModalChecklist(ticket);
        }
    } finally {
        setTicketProjectsModalLoading(false);
    }
}

async function submitTicketProjectsModalSave() {
    const tn = ticketProjectsModalTicketNumber;
    if (!tn || !isTicketProjectsModalDirty()) return;
    const tickets = window.ORG_TICKETS || [];
    const ticket = tickets.find((t) => String(t.ticketNumber) === String(tn));
    if (!ticket) return;
    const container = document.getElementById('ticketProjectsModalChecklist');
    if (!container) return;

    const baseline = new Set(JSON.parse(ticketProjectsModalBaselineSignature || '[]'));
    const nextKeys = new Set();
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        const key = cb.dataset.jobNameKey;
        if (!key || cb.disabled) return;
        if (cb.checked) nextKeys.add(key);
    });
    const toAdd = [];
    const toRemove = [];
    nextKeys.forEach((key) => {
        if (!baseline.has(key)) toAdd.push(key);
    });
    baseline.forEach((key) => {
        if (!nextKeys.has(key)) {
            const cb = container.querySelector(`input[data-job-name-key="${CSS.escape(key)}"]`);
            const source = cb && cb.dataset.membershipSource ? cb.dataset.membershipSource : 'auto';
            toRemove.push({ key, source });
        }
    });

    setTicketProjectsModalSaving(true);
    try {
        for (const key of toAdd) {
            await addTicketToProject(ticket, key);
        }
        for (const item of toRemove) {
            await removeTicketFromProject(ticket, item.key, item.source);
        }
        ticketProjectsModalSkipDirtyOnClose = true;
        await closeTicketProjectsModal();
    } catch (err) {
        if (typeof window.appAlert === 'function') {
            void window.appAlert(err && err.message ? err.message : 'Failed to update projects');
        }
        ticketProjectsOpenProjectsCache = null;
        await populateTicketProjectsModalChecklist(ticket);
    } finally {
        setTicketProjectsModalSaving(false);
        syncTicketProjectsSaveButton();
    }
}

async function createTicketProjectFromModal() {
    const tn = ticketProjectsModalTicketNumber;
    if (!tn) return;
    const tickets = window.ORG_TICKETS || [];
    const ticket = tickets.find((t) => String(t.ticketNumber) === String(tn));
    if (!ticket || ticketProjectMembershipReadOnly(ticket)) return;
    const name =
        typeof window.appPrompt === 'function'
            ? await window.appPrompt('New project job name:', '')
            : window.prompt('New project job name:', '');
    if (name == null || String(name).trim() === '') return;
    const api = ticketProjectMembershipApiBase(ticket);
    try {
        const created = await window.authModule.apiRequest(`${api.base}/tickets/job-projects${api.q}`, {
            method: 'POST',
            body: JSON.stringify({ organizationId: api.orgId, jobName: String(name).trim() }),
        });
        ticketProjectsOpenProjectsCache = null;
        await populateTicketProjectsModalChecklist(ticket);
        const key =
            created && created.jobNameKey != null
                ? String(created.jobNameKey)
                : String(name).trim().toLowerCase();
        const container = document.getElementById('ticketProjectsModalChecklist');
        const cb = container && container.querySelector(`input[data-job-name-key="${CSS.escape(key)}"]`);
        if (cb && !cb.disabled) {
            cb.checked = true;
            syncTicketProjectsSaveButton();
        }
    } catch (err) {
        if (typeof window.appAlert === 'function') {
            void window.appAlert(err && err.message ? err.message : 'Failed to create project');
        }
    }
}

function wireTicketProjectsModalCreateButton() {
    const createBtn = document.getElementById('ticketProjectsModalCreateBtn');
    if (!createBtn || createBtn.dataset.wired === '1') return;
    createBtn.dataset.wired = '1';
    createBtn.addEventListener('click', () => {
        void createTicketProjectFromModal();
    });
}

function wireTicketProjectsField(ticket) {
    const btn = document.getElementById('ticketProjectsBtn');
    if (!btn || btn.dataset.ticketProjectsInit === '1') return;
    btn.dataset.ticketProjectsInit = '1';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        const prevHtml = btn.innerHTML;
        btn.innerHTML = '<span class="ticket-action-btn-spinner" aria-hidden="true"></span>';
        void openTicketProjectsModal(ticket.ticketNumber).finally(() => {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.innerHTML = prevHtml;
            void loadTicketProjectsField(ticket, btn);
        });
    });
    void loadTicketProjectsField(ticket, btn);
    wireTicketProjectsModalCreateButton();
}

function wireTicketHubProjectsField(container, ticket) {
    const btn = container && container.querySelector('#ticketHubDetailProjectsBtn');
    if (!btn || !ticket) return;
    btn.onclick = function (e) {
        e.stopPropagation();
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        const prevHtml = btn.innerHTML;
        btn.innerHTML = '<span class="ticket-action-btn-spinner" aria-hidden="true"></span>';
        void openTicketProjectsModal(ticket.ticketNumber).finally(() => {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.innerHTML = prevHtml;
            void loadTicketProjectsField(ticket, btn);
        });
    };
    void loadTicketProjectsField(ticket, btn);
    wireTicketProjectsModalCreateButton();
}

window.buildTicketProjectsFieldHtml = buildTicketProjectsFieldHtml;
window.buildTicketHubProjectsFieldBlockHtml = buildTicketHubProjectsFieldBlockHtml;
window.wireTicketProjectsField = wireTicketProjectsField;
window.wireTicketHubProjectsField = wireTicketHubProjectsField;
window.loadTicketProjectsField = loadTicketProjectsField;
window.openTicketProjectsModal = openTicketProjectsModal;
window.closeTicketProjectsModal = closeTicketProjectsModal;
window.submitTicketProjectsModalSave = submitTicketProjectsModalSave;
window.formatTicketProjectsLabel = formatTicketProjectsLabel;
window.resolveTicketProjectJobKey = resolveTicketProjectJobKey;
window.shouldShowOpenProjectAction = shouldShowOpenProjectAction;
window.openTicketProjectInHub = openTicketProjectInHub;
