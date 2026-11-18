/**
 * Workflow acknowledgement UI (manual READY). See computeWorkflowStatus / detailWorkflowRoutes.
 */
const ACK_BLOCKING_OPERATOR_CODES =
    window.operatorResponseCodesModule && window.operatorResponseCodesModule.DEFAULT_ACK_BLOCKING_CODES
        ? window.operatorResponseCodesModule.DEFAULT_ACK_BLOCKING_CODES
        : ['000', '888', '999', '014', '050', '020', '021', '024', '052', '054', '041', '042', '555'];

function ackBlockingCodesForOrg() {
    const mod = window.workflowAckComplianceModule;
    if (mod && typeof mod.getAckBlockingCodesForCurrentOrg === 'function') {
        return mod.getAckBlockingCodesForCurrentOrg();
    }
    return ACK_BLOCKING_OPERATOR_CODES;
}

function userMayAcknowledgeWorkflow() {
    if (!window.authModule) return false;
    if (typeof window.canEditCurrentOrg === 'function' && !window.canEditCurrentOrg()) return false;
    return true;
}

function userMayRevertWorkflowAck(ticket) {
    if (!window.authModule || !window.authModule.currentUser) return false;
    const user = window.authModule.currentUser;
    if (user.role === 'dev') return true;
    if (typeof window.authModule.isDev === 'function' && window.authModule.isDev()) return true;
    const oid =
        ticket && ticket.organizationId != null
            ? ticket.organizationId
            : user.organizationId;
    if (oid == null) return false;
    if (
        typeof window.authModule.getOrgRoleForOrg === 'function' &&
        window.authModule.getOrgRoleForOrg(oid) === 'admin'
    ) {
        return true;
    }
    const adminIds = user.adminOrganizationIds;
    return Array.isArray(adminIds) && adminIds.some((id) => Number(id) === Number(oid));
}

/** True when the ticket is owner-acked (READY is ack-driven for owner org). */
function ticketAppearsWorkflowAcked(ticket) {
    if (!ticket) return false;
    if (ticket.hasWorkflowAck) return true;
    return getTicketWorkflowStatus(ticket) === 'READY';
}

function operatorCodeFromResponse(response) {
    if (!response) return '';
    const code = response.statusCode ?? response.status_code;
    return code != null ? String(code).trim() : '';
}

function getNgenEnquiryStatus(ticket) {
    if (!ticket) return '';
    const raw =
        ticket.ngenEnquiryStatus ??
        ticket.providerEnquiryStatus ??
        ticket.currentNgenEnquiryStatus ??
        ticket.current_ngen_enquiry_status ??
        ticket.ngen_enquiry_status ??
        ticket.provider_enquiry_status;
    return raw != null ? String(raw).trim() : '';
}

/** USAN renewal notice — operator/count ack gates waived only when org enables renewalAckWaivers. */
function isRenewalEnquiryStatus(ticket) {
    return getNgenEnquiryStatus(ticket).toUpperCase() === 'RNEW';
}

function renewalAckWaiversApply(ticket) {
    const mod = window.workflowAckComplianceModule;
    const policy = mod ? mod.getCurrentOrgWorkflowAckPolicy() : { renewalAckWaivers: false };
    return isRenewalEnquiryStatus(ticket) && !!policy.renewalAckWaivers;
}

function ticketHasBlockingOperatorCodes(ticket) {
    const responses = ticket && Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
    const revMod = window.operatorResponseRevisionModule;
    const rows =
        revMod && typeof revMod.filterOperatorResponsesForCurrentRevision === 'function'
            ? revMod.filterOperatorResponsesForCurrentRevision(ticket, responses)
            : responses;
    const blocking = ackBlockingCodesForOrg();
    return rows.some((r) => blocking.includes(operatorCodeFromResponse(r)));
}

function ticketAckBlockedByOperatorCodes(ticket) {
    if (renewalAckWaiversApply(ticket)) return false;
    return ticketHasBlockingOperatorCodes(ticket);
}

function getTicketWorkflowStatus(ticket) {
    if (!ticket) return '';
    return (
        ticket.computedWorkflowStatus ||
        ticket.status ||
        ticket.workflowStatus ||
        ''
    );
}

function shouldShowReadyButton(ticket, opts) {
    // Hide only true partner shares; lodgement "external" tickets may still be acked.
    if (!ticket || ticket.shared || (opts && opts.shared)) return false;
    if (!userMayAcknowledgeWorkflow()) return false;
    const wfStatus = getTicketWorkflowStatus(ticket);
    if (wfStatus === 'NOT_READY' && !renewalAckWaiversApply(ticket)) return false;
    if (wfStatus === 'READY' || wfStatus === 'CANCELLED' || wfStatus === 'EXPIRED') {
        return false;
    }
    return !ticketAppearsWorkflowAcked(ticket);
}

function shouldShowRevertAckButton(ticket, opts) {
    // Hide only true partner shares; lodgement "external" tickets still get Un-ack.
    if (!ticket || ticket.shared || (opts && opts.shared)) return false;
    return ticketAppearsWorkflowAcked(ticket) && userMayRevertWorkflowAck(ticket);
}

function buildReadyButtonHtml(opts) {
    const context = opts && opts.context === 'hub' ? 'hub' : 'popup';
    if (context === 'hub') {
        return (
            '<button type="button" class="ticket-hub-action-btn ticket-hub-action-secondary" ' +
            'data-hub-action="hub-workflow-ready" title="Mark ready (acknowledge workflow)">Ready?</button>'
        );
    }
    return (
        '<button type="button" class="ticket-popup-mock-btn ticket-popup-mock-btn--secondary ticket-popup-ready-btn" ' +
        'title="Mark ready (acknowledge workflow)">Ready?</button>'
    );
}

function buildRevertAckButtonHtml(opts) {
    const context = opts && opts.context === 'hub' ? 'hub' : 'popup';
    if (context === 'hub') {
        return (
            '<button type="button" class="ticket-hub-action-btn ticket-hub-action-secondary" ' +
            'data-hub-action="hub-workflow-revert-ack" title="Revert workflow acknowledgement">Un-ack</button>'
        );
    }
    return (
        '<button type="button" class="ticket-popup-header-unack-btn ticket-popup-revert-ack-btn" ' +
        'title="Revert workflow acknowledgement">Un-ack</button>'
    );
}

function workflowStatusBadgeClass(status) {
    switch (status) {
        case 'READY':
            return 'ready';
        case 'NOT_READY':
            return 'not-ready';
        case 'ACTION_REQUIRED':
            return 'action-required';
        case 'EXPIRING_SOON':
            return 'expiring-soon';
        case 'EXPIRED':
            return 'expired';
        case 'CANCELLED':
            return 'cancelled';
        default:
            return 'expired';
    }
}

/** Compact header glyph: green/red/gray dots, yellow warning, red stop. */
function workflowStatusIndicatorKind(status) {
    switch (status) {
        case 'READY':
            return 'ready';
        case 'ACTION_REQUIRED':
            return 'warning';
        case 'NOT_READY':
            return 'stop';
        case 'EXPIRING_SOON':
            return 'expiring';
        case 'EXPIRED':
        case 'CANCELLED':
        default:
            return 'neutral';
    }
}

function isCoreProductUi() {
    return typeof window !== 'undefined' && window.CORE_PRODUCT === true;
}

function buildStaticWorkflowStatusIndicatorHtml(status) {
    const kind = workflowStatusIndicatorKind(status);
    const label = workflowStatusDisplayLabel(status);
    return (
        `<span class="ticket-popup-status-indicator ticket-popup-status-indicator--${kind}"` +
        ` aria-label="Status: ${escapeWorkflowAckHtml(label)}"` +
        ` title="${escapeWorkflowAckHtml(label)}">` +
        `${buildWorkflowStatusIndicatorIconHtml(kind)}</span>`
    );
}

function preferCoreStatusIndicatorHtml(status, fallbackHtml) {
    if (isCoreProductUi()) return buildStaticWorkflowStatusIndicatorHtml(status);
    return fallbackHtml;
}

function buildWorkflowStatusIndicatorIconHtml(kind) {
    if (kind === 'ready' || kind === 'expiring' || kind === 'neutral') {
        return '<span class="ticket-popup-status-indicator-icon" aria-hidden="true"></span>';
    }
    if (kind === 'warning') {
        return (
            '<svg class="ticket-popup-status-indicator-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
            '<path fill="currentColor" d="M8 1.15L15.25 14.1H.75L8 1.15z"/>' +
            '<rect x="7.25" y="5.85" width="1.5" height="4.15" rx="0.35" fill="#111827"/>' +
            '<circle cx="8" cy="12.15" r="0.95" fill="#111827"/>' +
            '</svg>'
        );
    }
    // Octagon stop sign (NOT_READY): white border + center bar for legibility at small sizes.
    return (
        '<svg class="ticket-popup-status-indicator-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
        '<path fill="#fff" d="M5.15 1h5.7L15 5.15v5.7L10.85 15h-5.7L1 10.85v-5.7L5.15 1z"/>' +
        '<path fill="currentColor" d="M5.9 2.35h4.2L13.65 5.9v4.2L10.1 13.65H5.9L2.35 10.1V5.9L5.9 2.35z"/>' +
        '<rect fill="#fff" x="4.35" y="7" width="7.3" height="2" rx="0.25"/>' +
        '</svg>'
    );
}

function resolveOperatorResponseRowStatus(response) {
    return {
        operatorStatus: (response && (response.effectiveStatus || response.operatorStatus)) || 'READY',
    };
}

function getOperatorStatusExplanation(operatorStatus, response) {
    const code =
        response && response.statusCode != null && String(response.statusCode).trim() !== ''
            ? String(response.statusCode).trim()
            : '';
    switch (operatorStatus) {
        case 'NOT_READY':
            return code
                ? `Response code ${code} is classified as Not Ready.`
                : 'This operator response is classified as Not Ready.';
        case 'ACTION_REQUIRED':
            return code
                ? `Response code ${code} requires review before this ticket can be marked Ready.`
                : 'This operator response requires review.';
        default:
            return code
                ? `Response code ${code} is classified as Ready.`
                : 'This operator response is classified as Ready.';
    }
}

/** Per-operator row status glyph; click opens status explanation modal. */
function buildOperatorResponseStatusIndicatorHtml(opts) {
    opts = opts || {};
    const operatorStatus = opts.operatorStatus || 'READY';
    const respIndex = opts.respIndex;
    const stationLabel = opts.stationLabel != null ? String(opts.stationLabel) : '';
    const context = opts.context === 'hub' ? 'hub' : 'popup';
    const label = workflowStatusDisplayLabel(operatorStatus);
    const kind = opts.indicatorKind || workflowStatusIndicatorKind(operatorStatus);
    const ariaStation = stationLabel ? ` — ${stationLabel}` : '';
    const ariaLabel = `Status: ${label}${ariaStation}. Tap for details`;
    const popupClass = context === 'popup' ? ' ticket-popup-op-status-btn' : '';
    const hubAttr = context === 'hub' ? ' data-hub-action="op-status-detail"' : '';
    const idxAttr =
        respIndex != null && !Number.isNaN(Number(respIndex)) ? ` data-resp-index="${Number(respIndex)}"` : '';
    return (
        `<button type="button" class="ticket-popup-status-indicator operator-response-status-indicator ticket-popup-status-indicator--${kind}${popupClass}"` +
        `${hubAttr}${idxAttr}` +
        ` aria-label="${escapeWorkflowAckHtml(ariaLabel)}"` +
        ` title="${escapeWorkflowAckHtml(ariaLabel)}">` +
        `${buildWorkflowStatusIndicatorIconHtml(kind)}</button>`
    );
}

function buildWorkflowStatusIndicatorButtonHtml(ticket, opts) {
    opts = opts || {};
    const context = opts.context === 'hub' ? 'hub' : 'popup';
    const status =
        opts.status != null && opts.status !== ''
            ? opts.status
            : getTicketWorkflowStatus(ticket);
    const label = workflowStatusDisplayLabel(status);
    const kind = workflowStatusIndicatorKind(status);
    const hubAttr = context === 'hub' ? ' data-hub-action="hub-workflow-ready"' : '';
    const workflowBtnClass =
        context === 'hub'
            ? ' ticket-workflow-status-badge-btn'
            : ' ticket-popup-workflow-status-badge-btn';
    return (
        `<button type="button" class="ticket-popup-status-indicator ticket-popup-status-indicator--${kind}${workflowBtnClass}"` +
        `${hubAttr}` +
        ` aria-label="Status: ${escapeWorkflowAckHtml(label)}. View readiness requirements"` +
        ` title="View readiness requirements">` +
        `${buildWorkflowStatusIndicatorIconHtml(kind)}</button>`
    );
}

function buildPopupWorkflowStatusIndicatorHtml(ticket, opts) {
    return buildWorkflowStatusIndicatorButtonHtml(ticket, { ...(opts || {}), context: 'popup' });
}

/** Full text pill used in Responses toolbar (and similar). Click opens readiness modal. */
function buildPopupWorkflowStatusFullBadgeButtonHtml(ticket, opts) {
    opts = opts || {};
    const status =
        opts.status != null && opts.status !== ''
            ? opts.status
            : getTicketWorkflowStatus(ticket);
    const statusCls = workflowStatusBadgeClass(status);
    const label = workflowStatusDisplayLabel(status);
    return (
        `<button type="button" class="ticket-popup-operator-status-badge ${statusCls} ticket-workflow-status-badge-btn ticket-popup-workflow-status-badge-btn"` +
        ` title="View readiness requirements">${escapeWorkflowAckHtml(label)}</button>`
    );
}

function buildWorkflowAckModalStatusBadgeHtml(ticket) {
    if (!ticket) return '';
    const status = getTicketWorkflowStatus(ticket);
    const statusCls = workflowStatusBadgeClass(status);
    const label = workflowStatusDisplayLabel(status);
    return (
        `<span class="ticket-popup-operator-status-badge ${statusCls}">` +
        `${escapeWorkflowAckHtml(label)}</span>`
    );
}

function syncWorkflowAckModalStatusBadge(ticket) {
    const host = document.getElementById('workflowAckStatusBadge');
    if (!host) return;
    host.innerHTML = ticket ? buildWorkflowAckModalStatusBadgeHtml(ticket) : '';
}

function escapeWorkflowAckHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function workflowStatusDisplayLabel(status) {
    if (status == null || status === '') return 'Unknown';
    return typeof window.formatWorkflowStatusDisplay === 'function'
        ? window.formatWorkflowStatusDisplay(status)
        : String(status).replace(/_/g, ' ');
}

function shouldShowWorkflowStatusBadgeClick(ticket, _opts) {
    // Always interactive so users can open the readiness checklist.
    // Ack submit inside the modal stays permission-gated separately.
    return !!ticket;
}

function isWorkflowStatusBadgeInteractive(ticket, opts) {
    return shouldShowWorkflowStatusBadgeClick(ticket, opts);
}

function buildWorkflowStatusBadgeHtml(ticket, opts) {
    if (!ticket) return '';
    opts = opts || {};
    const context = opts.context === 'popup' ? 'popup' : 'hub';
    if (isCoreProductUi() || opts.variant === 'indicator' || context === 'popup') {
        if (context === 'popup' && opts.variant === 'full' && !isCoreProductUi()) {
            return buildPopupWorkflowStatusFullBadgeButtonHtml(ticket, opts);
        }
        if (context === 'popup') {
            return buildPopupWorkflowStatusIndicatorHtml(ticket, opts);
        }
        return buildWorkflowStatusIndicatorButtonHtml(ticket, { ...opts, context: 'hub' });
    }
    const externalForOrg = !!opts.externalForOrg;
    const ackOpts = { externalForOrg };
    const status =
        opts.status != null && opts.status !== ''
            ? opts.status
            : getTicketWorkflowStatus(ticket);
    const statusCls = workflowStatusBadgeClass(status);
    const label = workflowStatusDisplayLabel(status);
    const clickable = shouldShowWorkflowStatusBadgeClick(ticket, ackOpts);
    const baseClass = 'ticket-card-status';

    if (clickable) {
        return (
            `<button type="button" class="${baseClass} ${statusCls} ticket-workflow-status-badge-btn"` +
            ` data-hub-action="hub-workflow-ready" title="View readiness requirements">${escapeWorkflowAckHtml(label)}</button>`
        );
    }
    return `<span class="${baseClass} ${statusCls}">${escapeWorkflowAckHtml(label)}</span>`;
}

function syncWorkflowStatusBadgeElement(el, ticket, opts) {
    if (!el || !ticket) return;
    opts = opts || {};
    const context = opts.context === 'popup' ? 'popup' : 'hub';
    if (isCoreProductUi() || context === 'popup' || opts.variant === 'indicator') {
        const host = el.parentNode;
        if (!host) return;
        const tmp = document.createElement('div');
        tmp.innerHTML =
            context === 'hub'
                ? buildWorkflowStatusIndicatorButtonHtml(ticket, { ...opts, context: 'hub' })
                : buildPopupWorkflowStatusIndicatorHtml(ticket, opts);
        const next = tmp.firstElementChild;
        if (next) host.replaceChild(next, el);
        return;
    }
    const externalForOrg = !!opts.externalForOrg;
    const ackOpts = { externalForOrg };
    const status =
        opts.status != null && opts.status !== ''
            ? opts.status
            : getTicketWorkflowStatus(ticket);
    const label = workflowStatusDisplayLabel(status);
    const statusCls = workflowStatusBadgeClass(status);
    const clickable = shouldShowWorkflowStatusBadgeClick(ticket, ackOpts);

    el.textContent = label;
    if (clickable) {
        el.title = 'View readiness requirements';
    } else {
        el.removeAttribute('title');
    }

    el.className = `ticket-card-status ${statusCls}`;
    if (clickable) {
        el.classList.add('ticket-workflow-status-badge-btn');
        el.setAttribute('data-hub-action', 'hub-workflow-ready');
    } else {
        el.removeAttribute('data-hub-action');
    }
}

function workflowAckApiBase() {
    if (window.authModule && window.authModule.API_BASE) return window.authModule.API_BASE;
    if (window.API_BASE) return window.API_BASE;
    return '/api';
}

function workflowAckAuthHeaders(extra) {
    const headers = { ...(extra || {}) };
    if (window.authModule && typeof window.authModule.getAuthHeaders === 'function') {
        Object.assign(headers, window.authModule.getAuthHeaders());
    }
    return headers;
}

async function workflowAckApiRequest(path, options) {
    if (window.authModule && typeof window.authModule.apiRequest === 'function') {
        return window.authModule.apiRequest(path, options || {});
    }
    const apiBase = workflowAckApiBase();
    const cleanPath = String(path || '').replace(/^\//, '').replace(/^api\//, '');
    const res = await fetch(`${apiBase}/${cleanPath}`, {
        credentials: 'include',
        ...options,
        headers: workflowAckAuthHeaders({
            'Content-Type': 'application/json',
            ...(options && options.headers),
        }),
    });
    const raw = await res.text();
    let data = {};
    if (raw) {
        try {
            data = JSON.parse(raw);
        } catch {
            throw new Error(
                res.ok
                    ? 'Invalid JSON from server'
                    : `Request failed (${res.status}) — server returned HTML instead of JSON`
            );
        }
    }
    if (!res.ok) {
        throw new Error((data && data.error) || res.statusText || 'Request failed');
    }
    return data;
}

async function fetchCompliancePhotoCount(ticket) {
    if (!ticket || ticket.id == null) return 0;
    const orgId =
        ticket.organizationId != null
            ? ticket.organizationId
            : window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function'
              ? window.orgSelectorModule.getCurrentOrgId()
              : window.authModule?.currentUser?.organizationId;
    if (!orgId) return 0;
    try {
        const params = new URLSearchParams({
            organizationId: String(orgId),
            ticketId: String(ticket.id),
            tab: 'compliance',
            page: '1',
            limit: '200',
        });
        const data = await workflowAckApiRequest(`data/media/photos/for-ticket?${params.toString()}`, {
            method: 'GET',
            headers: {},
        });
        if (typeof data.total === 'number') return data.total;
        return Array.isArray(data.items) ? data.items.length : 0;
    } catch (e) {
        console.error('fetchCompliancePhotoCount:', e);
        return 0;
    }
}

function snapshotTicketForWorkflowAck(ticket) {
    if (!ticket || typeof ticket !== 'object') return null;
    const compliance = ticket.workflowAckCompliance;
    const responses = Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
    return {
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        organizationId: ticket.organizationId,
        shared: !!ticket.shared,
        hasWorkflowAck: !!ticket.hasWorkflowAck,
        status: ticket.status,
        computedWorkflowStatus: ticket.computedWorkflowStatus,
        workflowStatus: ticket.workflowStatus,
        ngenEnquiryStatus: ticket.ngenEnquiryStatus,
        providerEnquiryStatus: ticket.providerEnquiryStatus,
        currentNgenEnquiryStatus: ticket.currentNgenEnquiryStatus,
        ticketRevision: ticket.ticketRevision,
        photoRequirementCutoffPending: ticket.photoRequirementCutoffPending,
        workflowAckCompliance:
            compliance && typeof compliance === 'object'
                ? {
                      photoCount: compliance.photoCount,
                      qualifyingDroneMaps: compliance.qualifyingDroneMaps,
                      satisfied: compliance.satisfied,
                      pending: compliance.pending,
                  }
                : null,
        operatorResponses: responses.map((r) =>
            r && typeof r === 'object'
                ? {
                      statusCode: r.statusCode ?? r.status_code,
                      ticketRevisionSnapshot: r.ticketRevisionSnapshot,
                  }
                : null
        ),
    };
}

function isWorkflowAckModalVisible() {
    const modal = document.getElementById('workflowAckModal');
    return !!(modal && modal.style.display && modal.style.display !== 'none');
}

async function evaluateWorkflowAckGates(ticket) {
    const mod = window.workflowAckComplianceModule;
    const policy = mod ? mod.getCurrentOrgWorkflowAckPolicy() : { requiredPhotoCount: 0, droneMapMode: 'none' };
    const liveTicket = ticket;
    const evidence = mod ? mod.getTicketWorkflowAckEvidence(liveTicket) : null;
    const evidenceRequired = !!(policy && policy.requiredPhotoCount > 0);

    const status = getTicketWorkflowStatus(liveTicket);
    const renewalWaivers = renewalAckWaiversApply(liveTicket);

    const gates = {
        renewalWaivers,
        statusOk:
            (status !== 'NOT_READY' || renewalWaivers) &&
            status !== 'CANCELLED' &&
            status !== 'EXPIRED',
        notAlreadyAcked: !liveTicket.hasWorkflowAck && status !== 'READY',
        operatorsOk: !ticketAckBlockedByOperatorCodes(liveTicket),
        photoCount: 0,
        photosOk: false,
        compliancePending: false,
    };

    const drones =
        evidence && Number.isFinite(Number(evidence.qualifyingDroneMaps))
            ? Number(evidence.qualifyingDroneMaps)
            : 0;

    if (!evidenceRequired) {
        gates.photosOk = true;
        gates.compliancePending = false;
        gates.complianceLabel = 'No photo or drone evidence required';
    } else if (evidence) {
        gates.photoCount = Number.isFinite(Number(evidence.photoCount)) ? Number(evidence.photoCount) : 0;
        gates.compliancePending = !!evidence.pending;
        gates.photosOk =
            !evidence.pending &&
            (typeof evidence.satisfied === 'boolean'
                ? evidence.satisfied
                : mod
                  ? mod.isAckComplianceSatisfied(liveTicket, policy, gates.photoCount)
                  : gates.photoCount >= policy.requiredPhotoCount);
    } else if (liveTicket.id != null) {
        gates.photoCount = await fetchCompliancePhotoCount(liveTicket);
        gates.photosOk = mod
            ? mod.isAckComplianceSatisfied(liveTicket, policy, gates.photoCount)
            : gates.photoCount >= policy.requiredPhotoCount;
    } else {
        gates.photosOk = mod ? mod.isAckComplianceSatisfied(liveTicket, policy, 0) : false;
    }

    if (evidenceRequired) {
        gates.complianceLabel = mod
            ? mod.formatAckComplianceAckChecklistLabel(policy, gates.photoCount, drones)
            : `At least ${policy.requiredPhotoCount} photos (${gates.photoCount} found)`;
        if (gates.compliancePending) {
            gates.complianceLabel = 'Photo requirement cutoff pending for this revision';
        }
    }

    gates.canAck =
        userMayAcknowledgeWorkflow() &&
        gates.statusOk &&
        gates.notAlreadyAcked &&
        gates.operatorsOk &&
        gates.photosOk &&
        !gates.compliancePending;
    return gates;
}

let workflowAckTicket = null;
let workflowAckModalOpenInFlight = false;

function closeWorkflowAckModal() {
    const modal = document.getElementById('workflowAckModal');
    if (modal) modal.style.display = 'none';
    setWorkflowAckModalRevertVisible(false);
    syncWorkflowAckModalStatusBadge(null);
    const passwordInput = document.getElementById('workflowAckPassword');
    if (passwordInput) {
        passwordInput.value = '';
        if (typeof window.setPasswordFieldAutofillActive === 'function') {
            window.setPasswordFieldAutofillActive(passwordInput, false);
        }
    }
    workflowAckTicket = null;
}

function setWorkflowAckModalAckFormVisible(modal, visible) {
    if (!modal) return;
    const passwordInput = document.getElementById('workflowAckPassword');
    const noteInput = document.getElementById('workflowAckNote');
    const submitBtn = document.getElementById('workflowAckSubmitBtn');
    const passwordBlock = passwordInput && passwordInput.closest('div');
    const noteBlock = noteInput && noteInput.closest('div');
    const actions = modal.querySelector('.modal-actions');
    const cancelBtn = actions && actions.querySelector('button:not(#workflowAckRevertBtn)');
    const titleEl = modal.querySelector('.modal-title');
    const introEl = modal.querySelector('.modal-body p');

    if (passwordBlock) passwordBlock.style.display = visible ? '' : 'none';
    if (noteBlock) noteBlock.style.display = visible ? '' : 'none';
    if (submitBtn) submitBtn.style.display = visible ? '' : 'none';
    if (cancelBtn) cancelBtn.textContent = visible ? 'Cancel' : 'Close';
    if (titleEl) titleEl.textContent = visible ? 'Mark ticket ready' : 'Ticket readiness';
    if (introEl) {
        introEl.textContent = visible
            ? 'Confirm you have reviewed utility responses and photos for this revision.'
            : 'Requirements to mark this ticket ready for the current revision.';
    }
    if (passwordInput && typeof window.setPasswordFieldAutofillActive === 'function') {
        window.setPasswordFieldAutofillActive(passwordInput, !!visible, 'current');
    }
}

function setWorkflowAckModalRevertVisible(visible) {
    const revertBtn = document.getElementById('workflowAckRevertBtn');
    if (revertBtn) revertBtn.style.display = visible ? '' : 'none';
}

function openWorkflowAckModal(ticket) {
    if (!ticket) return;
    if (workflowAckModalOpenInFlight) return;
    workflowAckModalOpenInFlight = true;
    window.setTimeout(() => {
        let snapshot = ticket;
        try {
            snapshot = snapshotTicketForWorkflowAck(ticket) || ticket;
        } catch (e) {
            console.error('snapshotTicketForWorkflowAck:', e);
        }
        void openWorkflowAckModalInner(snapshot).finally(() => {
            workflowAckModalOpenInFlight = false;
        });
    }, 0);
}

async function openWorkflowAckModalInner(ticket) {
    workflowAckTicket = ticket;
    const modal = document.getElementById('workflowAckModal');
    const checklist = document.getElementById('workflowAckChecklist');
    const submitBtn = document.getElementById('workflowAckSubmitBtn');
    const passwordInput = document.getElementById('workflowAckPassword');
    const noteInput = document.getElementById('workflowAckNote');
    if (!modal || !checklist) return;
    const mayAck = userMayAcknowledgeWorkflow();
    const mayRevert = shouldShowRevertAckButton(ticket);
    const showAckForm = mayAck && !ticketAppearsWorkflowAcked(ticket);
    setWorkflowAckModalAckFormVisible(modal, showAckForm);
    setWorkflowAckModalRevertVisible(mayRevert);
    syncWorkflowAckModalStatusBadge(ticket);
    if (passwordInput) passwordInput.value = '';
    if (noteInput) noteInput.value = '';
    while (checklist.firstChild) checklist.removeChild(checklist.firstChild);
    const loading = document.createElement('div');
    loading.style.color = 'var(--app-text-secondary)';
    loading.textContent = 'Checking requirements…';
    checklist.appendChild(loading);
    if (submitBtn) submitBtn.disabled = true;
    modal.style.display = 'flex';

    let gates;
    try {
        gates = await evaluateWorkflowAckGates(ticket);
    } catch (e) {
        console.error('evaluateWorkflowAckGates:', e);
        while (checklist.firstChild) checklist.removeChild(checklist.firstChild);
        const errLine = document.createElement('div');
        errLine.style.color = 'var(--app-danger)';
        errLine.textContent = e.message || 'Could not check acknowledgement requirements.';
        checklist.appendChild(errLine);
        return;
    }
    const stillShowAckForm = mayAck && gates.notAlreadyAcked;
    setWorkflowAckModalAckFormVisible(modal, stillShowAckForm);
    setWorkflowAckModalRevertVisible(shouldShowRevertAckButton(ticket));
    const ackPolicy =
        window.workflowAckComplianceModule && typeof window.workflowAckComplianceModule.getCurrentOrgWorkflowAckPolicy === 'function'
            ? window.workflowAckComplianceModule.getCurrentOrgWorkflowAckPolicy()
            : { requiredPhotoCount: 0 };
    const blockingCodes = ackBlockingCodesForOrg().join(', ');
    const items = [
        {
            ok: gates.statusOk,
            label: gates.renewalWaivers
                ? 'Utility responses not required (USAN renewal / RNEW)'
                : 'Utilities responded (not Not Ready)',
        },
        {
            ok: gates.operatorsOk,
            label: gates.renewalWaivers
                ? 'Operator codes waived (USAN renewal / RNEW)'
                : `No pending operator codes (${blockingCodes})`,
        },
    ];
    if (ackPolicy.requiredPhotoCount > 0) {
        items.push({
            ok: gates.photosOk,
            label:
                gates.complianceLabel ||
                `At least ${ackPolicy.requiredPhotoCount} photos (${gates.photoCount} found)`,
        });
    }
    while (checklist.firstChild) checklist.removeChild(checklist.firstChild);
    items.forEach((item) => {
        const line = document.createElement('div');
        line.style.display = 'flex';
        line.style.alignItems = 'center';
        line.style.gap = '0.5rem';
        line.style.marginBottom = '0.35rem';
        line.style.color = 'var(--app-text-primary)';

        const dot = document.createElement('span');
        dot.setAttribute('aria-hidden', 'true');
        dot.style.display = 'block';
        dot.style.width = '0.75rem';
        dot.style.height = '0.75rem';
        dot.style.borderRadius = '50%';
        dot.style.flexShrink = '0';
        dot.style.background = item.ok ? 'var(--app-success)' : 'var(--app-danger)';

        const label = document.createElement('span');
        label.textContent = item.label;

        line.appendChild(dot);
        line.appendChild(label);
        checklist.appendChild(line);
    });
    if (submitBtn) submitBtn.disabled = !mayAck || !gates.canAck;
}

async function submitWorkflowAck() {
    if (!workflowAckTicket) return;
    const passwordInput = document.getElementById('workflowAckPassword');
    const noteInput = document.getElementById('workflowAckNote');
    const submitBtn = document.getElementById('workflowAckSubmitBtn');
    const password = passwordInput ? String(passwordInput.value || '') : '';
    const note = noteInput ? String(noteInput.value || '') : '';
    if (!password) {
        alert('Account password is required.');
        return;
    }
    if (submitBtn) submitBtn.disabled = true;
    try {
        const orgId =
            workflowAckTicket.organizationId != null
                ? workflowAckTicket.organizationId
                : window.authModule?.currentUser?.organizationId;
        await workflowAckApiRequest('tickets/acknowledge-workflow', {
            method: 'PUT',
            body: JSON.stringify({
                organizationId: orgId,
                ticketNumber: workflowAckTicket.ticketNumber,
                password,
                note,
            }),
        });
        closeWorkflowAckModal();
        if (typeof window.loadTicketsForCurrentOrg === 'function') {
            await window.loadTicketsForCurrentOrg({ preserveSelection: true, refreshOpenPopup: true, forceRefresh: true });
        }
    } catch (e) {
        alert(e.message || String(e));
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

async function revertWorkflowAck(ticket) {
    if (!ticket || !userMayRevertWorkflowAck(ticket)) return;
    if (!confirm('Revert workflow acknowledgement for this ticket?')) return;
    const orgId =
        ticket.organizationId != null ? ticket.organizationId : window.authModule?.currentUser?.organizationId;
    try {
        await workflowAckApiRequest('tickets/acknowledge-workflow', {
            method: 'DELETE',
            body: JSON.stringify({
                organizationId: orgId,
                ticketNumber: ticket.ticketNumber,
            }),
        });
        closeWorkflowAckModal();
        if (typeof window.loadTicketsForCurrentOrg === 'function') {
            await window.loadTicketsForCurrentOrg({ preserveSelection: true, refreshOpenPopup: true, forceRefresh: true });
        }
    } catch (e) {
        alert(e.message || String(e));
    }
}

function bindWorkflowAckModalHandlers() {
    const submitBtn = document.getElementById('workflowAckSubmitBtn');
    if (submitBtn && !submitBtn.dataset.bound) {
        submitBtn.dataset.bound = '1';
        submitBtn.addEventListener('click', () => void submitWorkflowAck());
    }
    const revertBtn = document.getElementById('workflowAckRevertBtn');
    if (revertBtn && !revertBtn.dataset.bound) {
        revertBtn.dataset.bound = '1';
        revertBtn.addEventListener('click', () => {
            if (!workflowAckTicket) return;
            void revertWorkflowAck(workflowAckTicket);
        });
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindWorkflowAckModalHandlers);
    } else {
        bindWorkflowAckModalHandlers();
    }
}

window.workflowAckModule = {
    ACK_BLOCKING_OPERATOR_CODES,
    userMayAcknowledgeWorkflow,
    userMayRevertWorkflowAck,
    ticketAppearsWorkflowAcked,
    getNgenEnquiryStatus,
    isRenewalEnquiryStatus,
    getTicketWorkflowStatus,
    shouldShowReadyButton,
    shouldShowRevertAckButton,
    buildReadyButtonHtml,
    buildRevertAckButtonHtml,
    workflowStatusBadgeClass,
    workflowStatusIndicatorKind,
    buildStaticWorkflowStatusIndicatorHtml,
    preferCoreStatusIndicatorHtml,
    resolveOperatorResponseRowStatus,
    getOperatorStatusExplanation,
    buildOperatorResponseStatusIndicatorHtml,
    shouldShowWorkflowStatusBadgeClick,
    isWorkflowStatusBadgeInteractive,
    buildWorkflowStatusBadgeHtml,
    syncWorkflowStatusBadgeElement,
    evaluateWorkflowAckGates,
    openWorkflowAckModal,
    isWorkflowAckModalVisible,
    closeWorkflowAckModal,
    submitWorkflowAck,
    revertWorkflowAck,
};
