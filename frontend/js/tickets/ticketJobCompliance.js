'use strict';

const JOB_COMPLIANCE_NOTES_MAX = 4000;
const JOB_COMPLIANCE_CUSTOM_ITEM_LABEL_MAX = 200;
const JOB_COMPLIANCE_CUSTOM_ITEM_NOTES_MAX = 2000;

function jobComplianceReadOnlyForTicket(ticket) {
    if (typeof window.ticketNotesReadOnlyForTicket === 'function') {
        return window.ticketNotesReadOnlyForTicket(ticket);
    }
    if (!ticket) return true;
    if (typeof isHubTicketExternalForOrg === 'function' && isHubTicketExternalForOrg(ticket)) {
        return true;
    }
    return !!(ticket && ticket.shared);
}

function jobComplianceApiBase(ticket) {
    const tn = ticket && ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    if (!tn) return null;
    const base =
        window.authModule && window.authModule.API_BASE ? String(window.authModule.API_BASE) : '/api';
    let orgId = null;
    if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        orgId = window.orgSelectorModule.getCurrentOrgId();
    } else if (window.authModule && window.authModule.getCurrentUser) {
        const u = window.authModule.getCurrentUser();
        orgId = u && u.organizationId;
    }
    const q = orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : '';
    return { tn, base, q, orgId };
}

function pickJobNameForCompliance(ticket) {
    const stored =
        ticket && ticket.ngenUserReference != null ? String(ticket.ngenUserReference).trim() : '';
    if (stored) return stored;
    if (window.ticketHubDisplayMap && typeof window.ticketHubDisplayMap.pickTicketField === 'function') {
        const v = window.ticketHubDisplayMap.pickTicketField(ticket, 'jobName');
        if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    const candidates = [ticket && ticket.jobName, ticket && ticket.providerUserReference, ticket && ticket.jobNumberName];
    for (const c of candidates) {
        if (c != null && String(c).trim() !== '') return String(c).trim();
    }
    return null;
}

function escapeJobComplianceHtml(s) {
    if (typeof hubEscapeHtml === 'function') return hubEscapeHtml(s);
    if (typeof escapeHtmlTicketUi === 'function') return escapeHtmlTicketUi(s);
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatJobComplianceDateLabel(dateStr) {
    if (!dateStr) return '';
    if (isJobComplianceDateNa(dateStr)) return 'N/A';
    try {
        const d = new Date(`${String(dateStr).trim()}T12:00:00`);
        if (Number.isNaN(d.getTime())) return String(dateStr);
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_e) {
        return String(dateStr);
    }
}

function isJobComplianceDateNa(dateStr) {
    if (window.jobComplianceDatesApi && typeof window.jobComplianceDatesApi.isComplianceDateNa === 'function') {
        return window.jobComplianceDatesApi.isComplianceDateNa(dateStr);
    }
    return dateStr != null && /^n\/a$/i.test(String(dateStr).trim());
}

function isJobComplianceDateMissing(dateStr) {
    if (window.jobComplianceDatesApi && typeof window.jobComplianceDatesApi.isComplianceDateMissing === 'function') {
        return window.jobComplianceDatesApi.isComplianceDateMissing(dateStr);
    }
    return dateStr == null || String(dateStr).trim() === '';
}

function isJobComplianceDateAttentionRequired(dateStr) {
    if (window.jobComplianceDatesApi && typeof window.jobComplianceDatesApi.isComplianceDateAttentionRequired === 'function') {
        return window.jobComplianceDatesApi.isComplianceDateAttentionRequired(dateStr);
    }
    return false;
}

function computeJobComplianceAttentionFromData(data) {
    if (window.jobComplianceDatesApi && typeof window.jobComplianceDatesApi.computeJobComplianceAttentionRequired === 'function') {
        if (!data || !data.compliance) return false;
        return window.jobComplianceDatesApi.computeJobComplianceAttentionRequired(data.compliance);
    }
    return false;
}

function jobComplianceDateAttentionTitle() {
    if (window.jobComplianceDatesApi && typeof window.jobComplianceDatesApi.jobComplianceDateAttentionTitle === 'function') {
        return window.jobComplianceDatesApi.jobComplianceDateAttentionTitle();
    }
    return 'Due soon or overdue';
}

function refreshJobCompliancePanelFieldStyling(container) {
    if (!container) return;
    container.querySelectorAll('.job-compliance-field').forEach((field) => {
        const dateEl = field.querySelector('[data-job-compliance-date]');
        const naEl = field.querySelector('[data-job-compliance-na]');
        if (!dateEl) return;
        const val = readJobComplianceDateValue(dateEl, naEl);
        const missing = isJobComplianceDateMissing(val);
        const attention = !missing && isJobComplianceDateAttentionRequired(val);
        field.classList.toggle('job-compliance-field--missing', missing);
        field.classList.toggle('job-compliance-field--attention', attention);
        const title = jobComplianceDateFieldTitle(val);
        if (title) dateEl.setAttribute('title', title);
        else dateEl.removeAttribute('title');
    });
    container.querySelectorAll('.job-compliance-custom-item').forEach((item) => {
        const dateEl = item.querySelector('[data-job-compliance-custom-date]');
        const naEl = item.querySelector('[data-job-compliance-na]');
        if (!dateEl) return;
        const val = readJobComplianceDateValue(dateEl, naEl);
        const missing = isJobComplianceDateMissing(val);
        const attention = !missing && isJobComplianceDateAttentionRequired(val);
        item.classList.toggle('job-compliance-custom-item--missing', missing);
        item.classList.toggle('job-compliance-custom-item--attention', attention);
        const title = jobComplianceDateFieldTitle(val);
        if (title) dateEl.setAttribute('title', title);
        else dateEl.removeAttribute('title');
    });
}

async function fetchTicketJobComplianceStatus(ticket) {
    if (!ticket) return false;
    const api = jobComplianceApiBase(ticket);
    if (!api || !window.authModule || !window.authModule.apiRequest) {
        ticket.complianceAttentionRequired = false;
        return false;
    }
    try {
        const data = await window.authModule.apiRequest(
            `${api.base}/tickets/${encodeURIComponent(api.tn)}/job-compliance/status${api.q}`
        );
        ticket.complianceAttentionRequired = !!(data && data.attentionRequired);
        return ticket.complianceAttentionRequired;
    } catch (_e) {
        ticket.complianceAttentionRequired = false;
        return false;
    }
}

function jobComplianceDateMissingTitle() {
    if (window.jobComplianceDatesApi && typeof window.jobComplianceDatesApi.jobComplianceDateMissingTitle === 'function') {
        return window.jobComplianceDatesApi.jobComplianceDateMissingTitle();
    }
    return 'Set a date or choose N/A';
}

function jobComplianceDateFieldTitle(dateStr) {
    if (isJobComplianceDateMissing(dateStr)) return jobComplianceDateMissingTitle();
    if (isJobComplianceDateAttentionRequired(dateStr)) return jobComplianceDateAttentionTitle();
    return '';
}

function readJobComplianceDateValue(dateEl, naEl) {
    if (naEl && naEl.checked) return 'N/A';
    return dateEl && dateEl.value != null && String(dateEl.value).trim() ? String(dateEl.value).trim() : null;
}

function buildJobComplianceDateFieldHtml(id, label, value, readOnly) {
    const val = value != null ? String(value) : '';
    const isNa = isJobComplianceDateNa(val);
    const dateValue = isNa ? '' : val;
    const disabled = readOnly ? ' disabled' : '';
    const missing = isJobComplianceDateMissing(val);
    const attention = !missing && isJobComplianceDateAttentionRequired(val);
    const fieldClass = missing
        ? ' job-compliance-field--missing'
        : attention
          ? ' job-compliance-field--attention'
          : '';
    const title = jobComplianceDateFieldTitle(val);
    const attentionTitle = title ? ` title="${escapeJobComplianceHtml(title)}"` : '';
    const naChecked = isNa ? ' checked' : '';
    const dateDisabled = readOnly || isNa ? ' disabled' : '';
    const naDisabled = readOnly ? ' disabled' : '';
    return `<div class="job-compliance-field${fieldClass}">
        <label class="job-compliance-label" for="${id}">${escapeJobComplianceHtml(label)}</label>
        <div class="job-compliance-date-row">
            <input type="date" id="${id}" class="job-compliance-date-input" name="${id}" value="${escapeJobComplianceHtml(dateValue)}" data-job-compliance-date${attentionTitle}${dateDisabled}>
            <label class="job-compliance-na-toggle">
                <input type="checkbox" id="${id}-na" class="job-compliance-na-checkbox" data-job-compliance-na${naChecked}${naDisabled}>
                <span>N/A</span>
            </label>
        </div>
    </div>`;
}

function buildJobComplianceTextareaHtml(id, label, value, readOnly, maxLen) {
    const val = value != null ? String(value) : '';
    const disabled = readOnly ? ' disabled' : '';
    return `<div class="job-compliance-field">
        <label class="job-compliance-label" for="${id}">${escapeJobComplianceHtml(label)}</label>
        <textarea id="${id}" class="job-compliance-textarea" name="${id}" rows="3" maxlength="${maxLen}" placeholder=""${disabled}>${escapeJobComplianceHtml(val)}</textarea>
    </div>`;
}

function buildJobComplianceCustomItemHtml(item, index, readOnly) {
    const id = item && item.id != null ? String(item.id) : `new-${index}`;
    const label = item && item.label != null ? String(item.label) : '';
    const date = item && item.date != null ? String(item.date) : '';
    const notes = item && item.notes != null ? String(item.notes) : '';
    const disabled = readOnly ? ' disabled' : '';
    const removeBtn = readOnly
        ? ''
        : `<button type="button" class="job-compliance-custom-remove" data-job-compliance-remove="${escapeJobComplianceHtml(id)}" title="Remove item" aria-label="Remove item">&times;</button>`;
    const attention = !isJobComplianceDateMissing(date) && isJobComplianceDateAttentionRequired(date);
    const itemClass = isJobComplianceDateMissing(date)
        ? ' job-compliance-custom-item--missing'
        : attention
          ? ' job-compliance-custom-item--attention'
          : '';
    const title = jobComplianceDateFieldTitle(date);
    const attentionTitle = title ? ` title="${escapeJobComplianceHtml(title)}"` : '';
    const isNa = isJobComplianceDateNa(date);
    const dateValue = isNa ? '' : date;
    const dateDisabled = readOnly || isNa ? ' disabled' : '';
    const naChecked = isNa ? ' checked' : '';
    const naDisabled = readOnly ? ' disabled' : '';
    return `<div class="job-compliance-custom-item${itemClass}" data-job-compliance-item-id="${escapeJobComplianceHtml(id)}">
        <div class="job-compliance-custom-item-header">
            <label class="job-compliance-label">Custom item</label>
            ${removeBtn}
        </div>
        <input type="text" class="job-compliance-custom-label" data-job-compliance-custom-label placeholder="Label (e.g. Stormwater permit)" value="${escapeJobComplianceHtml(label)}" maxlength="${JOB_COMPLIANCE_CUSTOM_ITEM_LABEL_MAX}"${disabled}>
        <div class="job-compliance-date-row">
            <input type="date" class="job-compliance-custom-date" data-job-compliance-custom-date data-job-compliance-date value="${escapeJobComplianceHtml(dateValue)}"${attentionTitle}${dateDisabled}>
            <label class="job-compliance-na-toggle">
                <input type="checkbox" class="job-compliance-na-checkbox" data-job-compliance-na${naChecked}${naDisabled}>
                <span>N/A</span>
            </label>
        </div>
        <textarea class="job-compliance-custom-notes" data-job-compliance-custom-notes rows="2" maxlength="${JOB_COMPLIANCE_CUSTOM_ITEM_NOTES_MAX}" placeholder="Notes (optional)"${disabled}>${escapeJobComplianceHtml(notes)}</textarea>
    </div>`;
}

function buildJobComplianceFormHtml(compliance, readOnly) {
    const c = compliance || {};
    const customItems = Array.isArray(c.customItems) ? c.customItems : [];
    const customItemsHtml = customItems.length
        ? customItems.map((item, idx) => buildJobComplianceCustomItemHtml(item, idx, readOnly)).join('')
        : '<p class="job-compliance-custom-empty">No custom items yet.</p>';
    const addBtn = readOnly
        ? ''
        : `<button type="button" class="ticket-hub-action-btn job-compliance-add-item-btn" data-job-compliance-add-item>Add item</button>`;
    const attentionInfo =
        typeof window.buildAppInfoButtonHtml === 'function'
            ? window.buildAppInfoButtonHtml(
                  'Date field colors',
                  'Amber date fields are unset, due within 3 business days, or overdue. Choose N/A when a date does not apply.'
              )
            : '';
    return `<form class="job-compliance-form" data-job-compliance-form novalidate>
        ${attentionInfo ? `<div class="job-compliance-form-head">${attentionInfo}</div>` : ''}
        <div class="job-compliance-fields-grid">
            ${buildJobComplianceDateFieldHtml('jobCompliancePermitExpiration', 'Permit expiration', c.permitExpiration, readOnly)}
            ${buildJobComplianceDateFieldHtml('jobComplianceTrafficControlPermitExpiration', 'Traffic control permit expiration', c.trafficControlPermitExpiration, readOnly)}
            ${buildJobComplianceDateFieldHtml('jobComplianceThirdPartyInspectionDate', '3rd party entity inspection date', c.thirdPartyInspectionDate, readOnly)}
        </div>
        ${buildJobComplianceTextareaHtml('jobComplianceThirdPartyInspectionNotes', '3rd party inspection notes', c.thirdPartyInspectionNotes, readOnly, JOB_COMPLIANCE_NOTES_MAX)}
        ${buildJobComplianceTextareaHtml('jobComplianceGeneralNotes', 'General compliance notes', c.generalNotes, readOnly, JOB_COMPLIANCE_NOTES_MAX)}
        <div class="job-compliance-custom-section">
            <div class="job-compliance-custom-section-header">
                <h4 class="job-compliance-custom-title">Additional items</h4>
                ${addBtn}
            </div>
            <div class="job-compliance-custom-list" data-job-compliance-custom-list>${customItemsHtml}</div>
        </div>
        ${readOnly ? '' : `<div class="job-compliance-actions"><button type="submit" class="ticket-hub-action-btn ticket-hub-action-primary job-compliance-save-btn">Save compliance</button></div>`}
    </form>`;
}

function buildJobComplianceLinkedTicketsHtml(linkedTicketNumbers, currentTicketNumber) {
    const rows = Array.isArray(linkedTicketNumbers) ? linkedTicketNumbers : [];
    if (rows.length <= 1) return '';
    const list = rows.map((tn) => `<li>${escapeJobComplianceHtml(tn)}</li>`).join('');
    return `<div class="job-compliance-linked">Shared with ${rows.length} tickets:<ul class="job-compliance-linked-list">${list}</ul></div>`;
}

function updateJobComplianceTabDot(_container, ticket) {
    if (typeof window.refreshComplianceHubStatusForTicket === 'function' && ticket) {
        void window.refreshComplianceHubStatusForTicket(ticket);
    }
}

function buildJobCompliancePanelInnerHtml(ticket, opts) {
    const readOnly = (opts && opts.readOnly) || jobComplianceReadOnlyForTicket(ticket);
    const jobName = pickJobNameForCompliance(ticket);
    if (!jobName) {
        return `<div class="job-compliance-panel job-compliance-panel--no-job">
            <p class="job-compliance-empty">This ticket is not in a project yet. Add it to a project from the Projects section in Details, or set a USAN job name that matches an existing project.</p>
        </div>`;
    }
    const readOnlyHint = readOnly
        ? '<p class="job-compliance-readonly-hint">Compliance is managed by the ticket owner organization.</p>'
        : '';
    return `<div class="job-compliance-panel${readOnly ? ' job-compliance-panel--readonly' : ''}" data-job-compliance-job-name="${escapeJobComplianceHtml(jobName)}">
        ${readOnlyHint}
        <p class="job-compliance-share-hint">Shared across all tickets with job name: <strong>${escapeJobComplianceHtml(jobName)}</strong></p>
        <div class="job-compliance-linked-wrap" data-job-compliance-linked-wrap></div>
        <div class="job-compliance-body" data-job-compliance-body>
            <p class="job-compliance-loading">Loading compliance…</p>
        </div>
    </div>`;
}

function buildTicketCompliancePanelShellHtml(ticket, opts) {
    const innerHtml = buildJobCompliancePanelInnerHtml(ticket, opts);
    return `<div class="ticket-compliance-panel">${innerHtml}</div>`;
}

function buildTicketJobComplianceSectionHtml(ticket, opts) {
    const innerHtml = buildJobCompliancePanelInnerHtml(ticket, opts);
    return `<section class="ticket-notes-compliance-section" aria-labelledby="ticketNotesComplianceHeading">
        <h3 id="ticketNotesComplianceHeading" class="ticket-notes-compliance-heading">Misc compliance</h3>
        ${innerHtml}
    </section>`;
}

function collectJobComplianceCustomItems(listEl) {
    if (!listEl) return [];
    const items = [];
    listEl.querySelectorAll('.job-compliance-custom-item').forEach((row) => {
        const id = row.getAttribute('data-job-compliance-item-id') || `item-${items.length}`;
        const labelEl = row.querySelector('[data-job-compliance-custom-label]');
        const dateEl = row.querySelector('[data-job-compliance-custom-date]');
        const naEl = row.querySelector('[data-job-compliance-na]');
        const notesEl = row.querySelector('[data-job-compliance-custom-notes]');
        const label = labelEl && labelEl.value != null ? String(labelEl.value).trim() : '';
        if (!label) return;
        const date = readJobComplianceDateValue(dateEl, naEl);
        const notes = notesEl && notesEl.value != null ? String(notesEl.value).trim() : '';
        items.push({
            id,
            label,
            date: date || null,
            notes: notes || null,
        });
    });
    return items;
}

function jobProjectApiBase() {
    const base =
        window.authModule && window.authModule.API_BASE ? String(window.authModule.API_BASE) : '/api';
    let orgId = null;
    if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
        orgId = window.orgSelectorModule.getCurrentOrgId();
    } else if (window.authModule && window.authModule.getCurrentUser) {
        const u = window.authModule.getCurrentUser();
        orgId = u && u.organizationId;
    }
    const q = orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : '';
    return { base, q, orgId };
}

function buildJobCompliancePanelInnerHtmlForProject(project, opts) {
    const readOnly = !!(opts && opts.readOnly);
    const jobName = project && project.jobName != null ? String(project.jobName).trim() : '';
    const jobNameKey = project && project.jobNameKey != null ? String(project.jobNameKey).trim() : '';
    const readOnlyHint = readOnly
        ? '<p class="job-compliance-readonly-hint">Compliance is managed by the ticket owner organization.</p>'
        : '';
    return `<div class="job-compliance-panel${readOnly ? ' job-compliance-panel--readonly' : ''}" data-job-compliance-job-name="${escapeJobComplianceHtml(jobName)}" data-job-compliance-project-key="${escapeJobComplianceHtml(jobNameKey)}">
        ${readOnlyHint}
        <div class="job-compliance-body" data-job-compliance-body>
            <p class="job-compliance-loading">Loading compliance…</p>
        </div>
    </div>`;
}

function buildProjectCompliancePanelShellHtml(project, opts) {
    const innerHtml = buildJobCompliancePanelInnerHtmlForProject(project, opts);
    return `<div class="ticket-compliance-panel">${innerHtml}</div>`;
}

async function loadJobComplianceForProject(project, container) {
    if (!container || !project || !project.jobNameKey) return;
    const readOnly = !!(project && project.readOnly);
    const bodyEl = container.querySelector('[data-job-compliance-body]');
    if (bodyEl) {
        bodyEl.innerHTML = '<p class="job-compliance-loading">Loading compliance…</p>';
    }
    const api = jobProjectApiBase();
    if (!api || !window.authModule || !window.authModule.apiRequest) {
        if (bodyEl) bodyEl.innerHTML = '<p class="job-compliance-empty">Compliance unavailable.</p>';
        return;
    }
    try {
        const data = await window.authModule.apiRequest(
            `${api.base}/tickets/job-projects/${encodeURIComponent(project.jobNameKey)}/compliance${api.q}`
        );
        renderJobCompliancePanel(container, data, null, readOnly, { project, hideLinked: true });
        refreshJobCompliancePanelFieldStyling(container);
        if (typeof window.refreshComplianceHubProjectStatus === 'function') {
            void window.refreshComplianceHubProjectStatus(project.jobNameKey, data);
        }
    } catch (_e) {
        if (bodyEl) {
            bodyEl.innerHTML = '<p class="job-compliance-empty">Could not load compliance.</p>';
        }
    }
}

function wireJobComplianceProjectPanel(container, project) {
    if (!container || !project || !project.jobNameKey) return;
    const form = container.querySelector('[data-job-compliance-form]');
    if (!form || form.dataset.jobComplianceFormInit === '1') return;
    if (project.readOnly) return;
    form.dataset.jobComplianceFormInit = '1';
    wireJobComplianceDateNaToggles(form);

    const listEl = form.querySelector('[data-job-compliance-custom-list]');
    const addBtn = form.querySelector('[data-job-compliance-add-item]');

    function ensureCustomListHasItems() {
        if (!listEl) return;
        const empty = listEl.querySelector('.job-compliance-custom-empty');
        if (empty) empty.remove();
    }

    if (addBtn) {
        addBtn.addEventListener('click', () => {
            if (!listEl) return;
            ensureCustomListHasItems();
            const id = `item-${Date.now()}-${listEl.querySelectorAll('.job-compliance-custom-item').length}`;
            const html = buildJobComplianceCustomItemHtml({ id, label: '', date: '', notes: '' }, 0, false);
            listEl.insertAdjacentHTML('beforeend', html);
            wireJobComplianceDateNaToggles(listEl);
        });
    }

    if (listEl) {
        listEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-job-compliance-remove]');
            if (!btn) return;
            e.preventDefault();
            const row = btn.closest('.job-compliance-custom-item');
            if (row) row.remove();
            if (!listEl.querySelector('.job-compliance-custom-item')) {
                listEl.innerHTML = '<p class="job-compliance-custom-empty">No custom items yet.</p>';
            }
        });
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const saveBtn = form.querySelector('.job-compliance-save-btn');
        const api = jobProjectApiBase();
        if (!api || !window.authModule || !window.authModule.apiRequest) return;
        const permitEl = form.querySelector('#jobCompliancePermitExpiration');
        const permitNaEl = form.querySelector('#jobCompliancePermitExpiration-na');
        const trafficEl = form.querySelector('#jobComplianceTrafficControlPermitExpiration');
        const trafficNaEl = form.querySelector('#jobComplianceTrafficControlPermitExpiration-na');
        const inspectionDateEl = form.querySelector('#jobComplianceThirdPartyInspectionDate');
        const inspectionNaEl = form.querySelector('#jobComplianceThirdPartyInspectionDate-na');
        const inspectionNotesEl = form.querySelector('#jobComplianceThirdPartyInspectionNotes');
        const generalNotesEl = form.querySelector('#jobComplianceGeneralNotes');
        const payload = {
            organizationId: api.orgId,
            permitExpiration: readJobComplianceDateValue(permitEl, permitNaEl),
            trafficControlPermitExpiration: readJobComplianceDateValue(trafficEl, trafficNaEl),
            thirdPartyInspectionDate: readJobComplianceDateValue(inspectionDateEl, inspectionNaEl),
            thirdPartyInspectionNotes:
                inspectionNotesEl && inspectionNotesEl.value != null
                    ? String(inspectionNotesEl.value).trim()
                    : '',
            generalNotes:
                generalNotesEl && generalNotesEl.value != null ? String(generalNotesEl.value).trim() : '',
            customItems: collectJobComplianceCustomItems(listEl),
        };
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving…';
        }
        try {
            const data = await window.authModule.apiRequest(
                `${api.base}/tickets/job-projects/${encodeURIComponent(project.jobNameKey)}/compliance`,
                { method: 'PUT', body: JSON.stringify(payload) }
            );
            renderJobCompliancePanel(container, data, null, false, { project, hideLinked: true });
            refreshJobCompliancePanelFieldStyling(container);
            if (typeof window.refreshComplianceHubProjectStatus === 'function') {
                void window.refreshComplianceHubProjectStatus(project.jobNameKey, data);
            }
        } catch (err) {
            if (typeof window.appAlert === 'function') {
                void window.appAlert(err && err.message ? err.message : 'Failed to save compliance.');
            }
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save compliance';
            }
        }
    });
}

function renderJobCompliancePanel(container, data, ticket, readOnly, opts) {
    const bodyEl = container.querySelector('[data-job-compliance-body]');
    const linkedWrap = container.querySelector('[data-job-compliance-linked-wrap]');
    if (!bodyEl) return;
    const compliance = data && data.compliance ? data.compliance : null;
    bodyEl.innerHTML = buildJobComplianceFormHtml(compliance, readOnly);
    if (linkedWrap) {
        if (opts && opts.hideLinked) {
            linkedWrap.innerHTML = '';
        } else {
            linkedWrap.innerHTML = buildJobComplianceLinkedTicketsHtml(
                data && data.linkedTicketNumbers,
                ticket && ticket.ticketNumber
            );
        }
    }
    const updatedMeta = container.querySelector('[data-job-compliance-updated]');
    if (updatedMeta) updatedMeta.remove();
    if (compliance && compliance.updatedAt) {
        const by = compliance.updatedByName ? ` by ${compliance.updatedByName}` : '';
        const when =
            typeof window.formatRecordedDateTime === 'function'
                ? window.formatRecordedDateTime(compliance.updatedAt, '', String(compliance.updatedAt))
                : formatJobComplianceDateLabel(compliance.updatedAt);
        const meta = document.createElement('p');
        meta.className = 'job-compliance-updated';
        meta.setAttribute('data-job-compliance-updated', '1');
        meta.textContent = `Last updated${by}: ${when}`;
        bodyEl.insertAdjacentElement('afterend', meta);
    }
    if (!readOnly) {
        if (opts && opts.project) {
            wireJobComplianceProjectPanel(container, opts.project);
        } else {
            wireJobCompliancePanel(container, ticket);
        }
    }
}

async function loadTicketJobComplianceForPanel(ticket, container) {
    if (!container || !ticket) return;
    const readOnly = jobComplianceReadOnlyForTicket(ticket);
    const jobName = pickJobNameForCompliance(ticket);
    const bodyEl = container.querySelector('[data-job-compliance-body]');
    if (!jobName) return;
    if (bodyEl) {
        bodyEl.innerHTML = '<p class="job-compliance-loading">Loading compliance…</p>';
    }
    const api = jobComplianceApiBase(ticket);
    if (!api || !window.authModule || !window.authModule.apiRequest) {
        if (bodyEl) bodyEl.innerHTML = '<p class="job-compliance-empty">Compliance unavailable for this ticket.</p>';
        return;
    }
    try {
        const data = await window.authModule.apiRequest(
            `${api.base}/tickets/${encodeURIComponent(api.tn)}/job-compliance${api.q}`
        );
        ticket.complianceAttentionRequired = computeJobComplianceAttentionFromData(data);
        renderJobCompliancePanel(container, data, ticket, readOnly);
        refreshJobCompliancePanelFieldStyling(container);
        updateJobComplianceTabDot(container, ticket);
    } catch (_e) {
        if (bodyEl) {
            bodyEl.innerHTML = '<p class="job-compliance-empty">Could not load compliance.</p>';
        }
    }
}

function wireJobComplianceDateNaToggles(root) {
    if (!root) return;
    root.querySelectorAll('[data-job-compliance-na]').forEach((naEl) => {
        if (naEl.dataset.jobComplianceNaInit === '1') return;
        naEl.dataset.jobComplianceNaInit = '1';
        const row = naEl.closest('.job-compliance-date-row');
        const dateEl = row && row.querySelector('[data-job-compliance-date]');
        if (!dateEl) return;
        function syncFromNa() {
            if (naEl.disabled) return;
            if (naEl.checked) {
                dateEl.value = '';
                dateEl.disabled = true;
            } else {
                dateEl.disabled = false;
            }
        }
        naEl.addEventListener('change', syncFromNa);
        dateEl.addEventListener('change', () => {
            if (naEl.disabled) return;
            if (dateEl.value) {
                naEl.checked = false;
                dateEl.disabled = false;
            }
        });
        syncFromNa();
    });
}

function wireJobCompliancePanel(container, ticket) {
    if (!container || !ticket) return;
    const form = container.querySelector('[data-job-compliance-form]');
    if (!form || form.dataset.jobComplianceFormInit === '1') return;
    if (jobComplianceReadOnlyForTicket(ticket)) return;
    form.dataset.jobComplianceFormInit = '1';
    wireJobComplianceDateNaToggles(form);

    const listEl = form.querySelector('[data-job-compliance-custom-list]');
    const addBtn = form.querySelector('[data-job-compliance-add-item]');

    function ensureCustomListHasItems() {
        if (!listEl) return;
        const empty = listEl.querySelector('.job-compliance-custom-empty');
        if (empty) empty.remove();
    }

    if (addBtn) {
        addBtn.addEventListener('click', () => {
            if (!listEl) return;
            ensureCustomListHasItems();
            const id = `item-${Date.now()}-${listEl.querySelectorAll('.job-compliance-custom-item').length}`;
            const html = buildJobComplianceCustomItemHtml({ id, label: '', date: '', notes: '' }, 0, false);
            listEl.insertAdjacentHTML('beforeend', html);
            wireJobComplianceDateNaToggles(listEl);
        });
    }

    if (listEl) {
        listEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-job-compliance-remove]');
            if (!btn) return;
            e.preventDefault();
            const row = btn.closest('.job-compliance-custom-item');
            if (row) row.remove();
            if (!listEl.querySelector('.job-compliance-custom-item')) {
                listEl.innerHTML = '<p class="job-compliance-custom-empty">No custom items yet.</p>';
            }
        });
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const saveBtn = form.querySelector('.job-compliance-save-btn');
        const api = jobComplianceApiBase(ticket);
        if (!api || !window.authModule || !window.authModule.apiRequest) return;
        const permitEl = form.querySelector('#jobCompliancePermitExpiration');
        const permitNaEl = form.querySelector('#jobCompliancePermitExpiration-na');
        const trafficEl = form.querySelector('#jobComplianceTrafficControlPermitExpiration');
        const trafficNaEl = form.querySelector('#jobComplianceTrafficControlPermitExpiration-na');
        const inspectionDateEl = form.querySelector('#jobComplianceThirdPartyInspectionDate');
        const inspectionNaEl = form.querySelector('#jobComplianceThirdPartyInspectionDate-na');
        const inspectionNotesEl = form.querySelector('#jobComplianceThirdPartyInspectionNotes');
        const generalNotesEl = form.querySelector('#jobComplianceGeneralNotes');
        const payload = {
            organizationId: api.orgId,
            permitExpiration: readJobComplianceDateValue(permitEl, permitNaEl),
            trafficControlPermitExpiration: readJobComplianceDateValue(trafficEl, trafficNaEl),
            thirdPartyInspectionDate: readJobComplianceDateValue(inspectionDateEl, inspectionNaEl),
            thirdPartyInspectionNotes:
                inspectionNotesEl && inspectionNotesEl.value != null
                    ? String(inspectionNotesEl.value).trim()
                    : '',
            generalNotes:
                generalNotesEl && generalNotesEl.value != null ? String(generalNotesEl.value).trim() : '',
            customItems: collectJobComplianceCustomItems(listEl),
        };
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving…';
        }
        try {
            const data = await window.authModule.apiRequest(
                `${api.base}/tickets/${encodeURIComponent(api.tn)}/job-compliance`,
                { method: 'PUT', body: JSON.stringify(payload) }
            );
            ticket.complianceAttentionRequired = computeJobComplianceAttentionFromData(data);
            renderJobCompliancePanel(container, data, ticket, false);
            refreshJobCompliancePanelFieldStyling(container);
            updateJobComplianceTabDot(container, ticket);
        } catch (err) {
            if (typeof window.appAlert === 'function') {
                void window.appAlert(err && err.message ? err.message : 'Failed to save compliance.');
            }
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save compliance';
            }
        }
    });
}

window.fetchTicketJobComplianceStatus = fetchTicketJobComplianceStatus;
window.pickJobNameForCompliance = pickJobNameForCompliance;
window.buildTicketCompliancePanelShellHtml = buildTicketCompliancePanelShellHtml;
window.buildTicketJobComplianceSectionHtml = buildTicketJobComplianceSectionHtml;
window.loadTicketJobComplianceForPanel = loadTicketJobComplianceForPanel;
window.wireJobCompliancePanel = wireJobCompliancePanel;
window.buildProjectCompliancePanelShellHtml = buildProjectCompliancePanelShellHtml;
window.loadJobComplianceForProject = loadJobComplianceForProject;
window.wireJobComplianceProjectPanel = wireJobComplianceProjectPanel;
window.jobComplianceReadOnlyForTicket = jobComplianceReadOnlyForTicket;
