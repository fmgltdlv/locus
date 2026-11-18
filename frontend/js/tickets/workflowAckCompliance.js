/**
 * Per-org workflow ack compliance (photos + drone map). Mirrors cloudflare/deploy/src/lib/workflowAckCompliance.cjs
 */
const WORKFLOW_ACK_COMPLIANCE_KEY = 'workflowAckCompliance';
const DEFAULT_EXPIRING_SOON_DAYS = 5;
const MIN_EXPIRING_SOON_DAYS = 1;
const MAX_EXPIRING_SOON_DAYS = 15;
const DEFAULT_POLICY = Object.freeze({
    requiredPhotoCount: 0,
    droneMapMode: 'none',
    renewalAckWaivers: false,
    greenResponsesAfterAck: false,
    expiringSoonDays: DEFAULT_EXPIRING_SOON_DAYS,
    notReadyCodes: null,
    actionRequiredCodes: null,
    ackBlockingCodes: null,
});
const DRONE_MAP_MODES = Object.freeze(['none', 'alternative', 'required']);

function normalizeDroneMapMode(rawMode, legacyAlternative) {
    if (legacyAlternative === true) return 'alternative';
    const mode = rawMode != null ? String(rawMode).trim().toLowerCase() : 'none';
    return DRONE_MAP_MODES.includes(mode) ? mode : 'none';
}

function normalizeRequiredPhotoCount(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_POLICY.requiredPhotoCount;
    return Math.min(10, Math.max(0, Math.round(n)));
}

function normalizeExpiringSoonDays(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_POLICY.expiringSoonDays;
    return Math.min(MAX_EXPIRING_SOON_DAYS, Math.max(MIN_EXPIRING_SOON_DAYS, Math.round(n)));
}

function normalizeWorkflowAckComplianceSettings(raw) {
    const codeMod = window.operatorResponseCodesModule;
    const normalizeList =
        codeMod && typeof codeMod.normalizeOperatorCodeList === 'function'
            ? codeMod.normalizeOperatorCodeList
            : () => null;
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        requiredPhotoCount: 0,
        droneMapMode: 'none',
        renewalAckWaivers: src.renewalAckWaivers === true,
        greenResponsesAfterAck: src.greenResponsesAfterAck === true,
        expiringSoonDays: normalizeExpiringSoonDays(src.expiringSoonDays),
        notReadyCodes: normalizeList(src.notReadyCodes),
        actionRequiredCodes: normalizeList(src.actionRequiredCodes),
        ackBlockingCodes: normalizeList(src.ackBlockingCodes),
    };
}

function resolveOperatorCodeLists(policy) {
    const codeMod = window.operatorResponseCodesModule;
    if (codeMod && typeof codeMod.resolveOperatorCodeLists === 'function') {
        return codeMod.resolveOperatorCodeLists(policy);
    }
    return {
        notReadyCodes: [],
        actionRequiredCodes: [],
        ackBlockingCodes: [],
    };
}

function getOperatorStatusFromCode(responseCode, policy) {
    const codeMod = window.operatorResponseCodesModule;
    const lists = resolveOperatorCodeLists(policy || getCurrentOrgWorkflowAckPolicy());
    if (codeMod && typeof codeMod.getOperatorStatusFromCode === 'function') {
        return codeMod.getOperatorStatusFromCode(responseCode, lists);
    }
    return 'READY';
}

function getAckBlockingCodesForCurrentOrg() {
    return resolveOperatorCodeLists(getCurrentOrgWorkflowAckPolicy()).ackBlockingCodes;
}

function getOrgWorkflowAckPolicy(org) {
    const settings = org && org.settings && typeof org.settings === 'object' ? org.settings : {};
    return normalizeWorkflowAckComplianceSettings(settings[WORKFLOW_ACK_COMPLIANCE_KEY]);
}

function getCurrentOrgWorkflowAckPolicy() {
    if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrganization === 'function') {
        return getOrgWorkflowAckPolicy(window.orgSelectorModule.getCurrentOrganization());
    }
    if (window.authModule && window.authModule.currentUser) {
        const oid = window.authModule.currentUser.organizationId;
        const orgs =
            window.orgSelectorModule && typeof window.orgSelectorModule.getOrganizations === 'function'
                ? window.orgSelectorModule.getOrganizations()
                : [];
        const org = (orgs || []).find((o) => Number(o.id) === Number(oid));
        return getOrgWorkflowAckPolicy(org);
    }
    return { ...DEFAULT_POLICY };
}

function getTicketWorkflowAckEvidence(ticket) {
    if (ticket && ticket.workflowAckCompliance && typeof ticket.workflowAckCompliance === 'object') {
        return ticket.workflowAckCompliance;
    }
    return null;
}

function evaluateComplianceFromCounts(policy, photoCount, qualifyingDroneMaps, pending) {
    if (!policy) policy = { ...DEFAULT_POLICY };
    if (policy.requiredPhotoCount === 0) {
        return { satisfied: true, photosOk: true, droneOk: false, pending: false };
    }
    if (pending) {
        return { satisfied: false, photosOk: false, droneOk: false, pending: true };
    }
    const photosOk = Number(photoCount) >= policy.requiredPhotoCount;
    const droneOk = Number(qualifyingDroneMaps) >= 1;
    let satisfied = false;
    if (policy.droneMapMode === 'none') satisfied = photosOk;
    else if (policy.droneMapMode === 'alternative') satisfied = photosOk || droneOk;
    else if (policy.droneMapMode === 'required') satisfied = photosOk && droneOk;
    return { satisfied, photosOk, droneOk, pending: false };
}

function isAckComplianceSatisfied(ticket, policy, photoCount) {
    const serverEvidence = getTicketWorkflowAckEvidence(ticket);
    if (serverEvidence && typeof serverEvidence.satisfied === 'boolean') {
        return serverEvidence.satisfied;
    }
    const effectivePolicy = policy || getCurrentOrgWorkflowAckPolicy();
    const pending = !!(ticket && ticket.photoRequirementCutoffPending);
    const drones =
        serverEvidence && Number.isFinite(Number(serverEvidence.qualifyingDroneMaps))
            ? Number(serverEvidence.qualifyingDroneMaps)
            : 0;
    const count = Number.isFinite(Number(photoCount))
        ? Number(photoCount)
        : serverEvidence && Number.isFinite(Number(serverEvidence.photoCount))
          ? Number(serverEvidence.photoCount)
          : 0;
    return evaluateComplianceFromCounts(effectivePolicy, count, drones, pending).satisfied;
}

function formatAckComplianceCountLabel(policy, photoCount, qualifyingDroneMaps) {
    const p = policy || getCurrentOrgWorkflowAckPolicy();
    if (p.requiredPhotoCount === 0) return 'No evidence required';
    const photos = `${Number(photoCount) || 0} / ${p.requiredPhotoCount}`;
    if (p.droneMapMode === 'none') return `${photos} photos`;
    const drones = `${Number(qualifyingDroneMaps) || 0} / 1 drone`;
    if (p.droneMapMode === 'alternative') return `${photos} photos or ${drones}`;
    return `${photos} photos and ${drones}`;
}

function formatAckComplianceHint(policy, evidence, scopeLabel) {
    const p = policy || getCurrentOrgWorkflowAckPolicy();
    const scope = scopeLabel || 'this revision';
    if (p.requiredPhotoCount === 0) return `No photo or drone evidence required for ${scope}`;
    if (evidence && evidence.pending) {
        return 'Review Required: lodge date pending — cannot evaluate compliance yet';
    }
    const n = p.requiredPhotoCount;
    const photoPhrase =
        n === 1 ? `1 photo for ${scope}` : `At least ${n} photos for ${scope}`;
    const dronePhrase = '1 drone map over the ticket captured on or after submittal date';
    if (p.droneMapMode === 'none') {
        return evidence && evidence.satisfied ? `Requirement met for ${scope}` : `Review Required: ${photoPhrase}`;
    }
    if (p.droneMapMode === 'alternative') {
        return evidence && evidence.satisfied
            ? `Requirement met for ${scope}`
            : `Review Required: ${photoPhrase}, or ${dronePhrase}`;
    }
    return evidence && evidence.satisfied
        ? `Requirement met for ${scope}`
        : `Review Required: ${photoPhrase} and ${dronePhrase}`;
}

function isAckComplianceMetForDisplay(ticket, photoCount) {
    const policy = getCurrentOrgWorkflowAckPolicy();
    const evidence = getTicketWorkflowAckEvidence(ticket);
    const drones =
        evidence && Number.isFinite(Number(evidence.qualifyingDroneMaps))
            ? Number(evidence.qualifyingDroneMaps)
            : 0;
    const pending = !!(ticket && ticket.photoRequirementCutoffPending);
    const evalResult = evaluateComplianceFromCounts(policy, photoCount, drones, pending);
    if (evidence && typeof evidence.satisfied === 'boolean') {
        return evidence.satisfied ? 'READY' : 'ACTION_REQUIRED';
    }
    return evalResult.satisfied ? 'READY' : 'ACTION_REQUIRED';
}

function getPhotoComplianceDisplayState(ticket, photoCount, scopeLabel) {
    const policy = getCurrentOrgWorkflowAckPolicy();
    const evidence = getTicketWorkflowAckEvidence(ticket);
    const drones =
        evidence && Number.isFinite(Number(evidence.qualifyingDroneMaps))
            ? Number(evidence.qualifyingDroneMaps)
            : 0;
    const pending = !!(ticket && ticket.photoRequirementCutoffPending);
    const evalResult = evaluateComplianceFromCounts(policy, photoCount, drones, pending);
    const status = isAckComplianceMetForDisplay(ticket, photoCount);
    return {
        status,
        met: status === 'READY',
        countLabel: formatAckComplianceCountLabel(policy, photoCount, drones),
        hint: formatAckComplianceHint(
            policy,
            evidence || { ...evalResult, photoCount, qualifyingDroneMaps: drones, pending },
            scopeLabel
        ),
        policy,
        evidence,
    };
}

function formatAckComplianceAckChecklistLabel(policy, photoCount, qualifyingDroneMaps) {
    const p = policy || getCurrentOrgWorkflowAckPolicy();
    if (p.requiredPhotoCount === 0) return 'No photo or drone evidence required';
    const base = formatAckComplianceCountLabel(p, photoCount, qualifyingDroneMaps);
    if (p.droneMapMode === 'none') {
        return `${base} (${Number(photoCount) || 0} found)`;
    }
    const droneCount = Number(qualifyingDroneMaps) || 0;
    return `${base} (${Number(photoCount) || 0} photos, ${droneCount} drone map${droneCount === 1 ? '' : 's'})`;
}

window.workflowAckComplianceModule = {
    WORKFLOW_ACK_COMPLIANCE_KEY,
    DEFAULT_POLICY,
    DRONE_MAP_MODES,
    DEFAULT_EXPIRING_SOON_DAYS,
    MIN_EXPIRING_SOON_DAYS,
    MAX_EXPIRING_SOON_DAYS,
    getOrgWorkflowAckPolicy,
    getCurrentOrgWorkflowAckPolicy,
    getTicketWorkflowAckEvidence,
    evaluateComplianceFromCounts,
    isAckComplianceSatisfied,
    formatAckComplianceCountLabel,
    formatAckComplianceHint,
    isAckComplianceMetForDisplay,
    normalizeWorkflowAckComplianceSettings,
    getPhotoComplianceDisplayState,
    formatAckComplianceAckChecklistLabel,
    resolveOperatorCodeLists,
    getOperatorStatusFromCode,
    getAckBlockingCodesForCurrentOrg,
};
