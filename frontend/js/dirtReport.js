// DIRT Report module - DIRT (Damage Information Reporting Tool) reporting

const dirtReportTicketLinkCache = new Map();

function escapeDirtHtml(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function dirtReportCacheKey(report) {
    if (!report) return '';
    return String(report.id || report.clientLegacyId || report.ticketId || report.ticketNumber || '');
}

function findDirtReportTicketSync(report) {
    const tm = window.ticketsModule;
    if (!tm || typeof tm.findLiveTicketInLocalCollections !== 'function' || !report) return null;
    return tm.findLiveTicketInLocalCollections({
        id: report.ticketId,
        ticketNumber: report.ticketNumber,
    });
}

function dirtReportLinkedTicketStillLive(report, cachedTicket) {
    const fromReport = findDirtReportTicketSync(report);
    if (fromReport) return fromReport;
    const tm = window.ticketsModule;
    if (cachedTicket && tm && typeof tm.findLiveTicketInLocalCollections === 'function') {
        return tm.findLiveTicketInLocalCollections(cachedTicket);
    }
    return null;
}

async function resolveDirtReportTicketLink(report) {
    const key = dirtReportCacheKey(report);
    if (!key) {
        return { status: 'missing', ticket: null };
    }
    const cached = dirtReportTicketLinkCache.get(key);
    if (cached && cached.status === 'linked') {
        const stillLive = dirtReportLinkedTicketStillLive(report, cached.ticket);
        if (stillLive) {
            if (stillLive !== cached.ticket) {
                const linked = { status: 'linked', ticket: stillLive };
                dirtReportTicketLinkCache.set(key, linked);
                return linked;
            }
            return cached;
        }
        dirtReportTicketLinkCache.delete(key);
    } else if (cached && cached.status === 'missing') {
        const fromLive = findDirtReportTicketSync(report);
        if (fromLive) {
            const linked = { status: 'linked', ticket: fromLive };
            dirtReportTicketLinkCache.set(key, linked);
            return linked;
        }
        return cached;
    }

    const fromLive = findDirtReportTicketSync(report);
    if (fromLive) {
        const linked = { status: 'linked', ticket: fromLive };
        dirtReportTicketLinkCache.set(key, linked);
        return linked;
    }

    const tm = window.ticketsModule;
    const ticketNumber =
        report.ticketNumber != null && String(report.ticketNumber).trim() !== ''
            ? String(report.ticketNumber).trim()
            : '';
    if (tm && typeof tm.resolveTicketForOpen === 'function' && ticketNumber) {
        try {
            const hydrated = await tm.resolveTicketForOpen({
                ticketId: report.ticketId,
                ticketNumber: ticketNumber,
            });
            if (hydrated) {
                const linked = { status: 'linked', ticket: hydrated };
                dirtReportTicketLinkCache.set(key, linked);
                return linked;
            }
        } catch (err) {
            console.warn('[dirtReport] resolveTicketForOpen failed:', err);
        }
    }

    const missing = { status: 'missing', ticket: null };
    dirtReportTicketLinkCache.set(key, missing);
    return missing;
}

function invalidateDirtReportTicketLinkCache() {
    dirtReportTicketLinkCache.clear();
}

function getDirtReportTicketLinkStatus(report) {
    const key = dirtReportCacheKey(report);
    if (!key) return 'missing';
    if (findDirtReportTicketSync(report)) return 'linked';
    const cached = dirtReportTicketLinkCache.get(key);
    if (cached && cached.status === 'missing') return 'missing';
    if (cached && cached.status === 'linked') {
        if (dirtReportLinkedTicketStillLive(report, cached.ticket)) return 'linked';
        dirtReportTicketLinkCache.delete(key);
    }
    return 'loading';
}

function buildDirtReportTicketStub(report) {
    return {
        id: report.ticketId,
        ticketNumber: report.ticketNumber,
        address: report.address || '',
    };
}

async function findDirtReportByEventId(eventId) {
    if (eventId == null || eventId === '') return null;
    if (window.reportedEventsStore && window.reportedEventsStore.ensureLoaded) {
        try {
            await window.reportedEventsStore.ensureLoaded();
        } catch (_) {
            /* ignore */
        }
    }
    const fromApi = (window.reportedEventsStore && window.reportedEventsStore.getReportsForCurrentOrg
        ? window.reportedEventsStore.getReportsForCurrentOrg()
        : []) || [];
    let report = fromApi.find(
        (r, index) =>
            String(r.id) === String(eventId) ||
            String(r.clientLegacyId) === String(eventId) ||
            (r.id || `event-${index}`) === eventId
    );
    if (!report) {
        let currentOrgId = null;
        if (window.authModule && window.authModule.isAuthenticated()) {
            currentOrgId = window.authModule.getCurrentUser().organizationId;
        }
        try {
            const allReports = JSON.parse(localStorage.getItem('dirtReports') || '[]');
            const orgReports = allReports.filter((r) => r.organizationId === currentOrgId);
            report = orgReports.find(
                (r, index) =>
                    String(r.id) === String(eventId) ||
                    String(r.clientLegacyId) === String(eventId) ||
                    (r.id || `event-${index}`) === eventId
            );
        } catch (_) {
            report = null;
        }
    }
    return report || null;
}

function explainMissingDirtReportTicket(report) {
    const num =
        report && report.ticketNumber != null && String(report.ticketNumber).trim() !== ''
            ? String(report.ticketNumber).trim()
            : null;
    const ticketLabel = num || 'an unknown ticket';
    void appAlert(
        'This report is linked to ticket ' +
            ticketLabel +
            ", but that ticket is not in your organization's records right now. It may have been removed, never imported, or belong to a different organization.\n\n" +
            'What you can try: Run a USAN resync to pull tickets back into Locus, or confirm you are in the correct organization. You can still view and edit this report.'
    );
}

async function explainMissingDirtReportTicketForEvent(eventId) {
    const report = await findDirtReportByEventId(eventId);
    if (!report) return;
    explainMissingDirtReportTicket(report);
}

// Open DIRT report modal (optional: eventId to edit existing event)
async function openDirtReportModal(eventId) {
    const modal = document.getElementById('dirtReportModal');
    const content = document.getElementById('dirtReportContent');

    if (!modal || !content) {
        void appAlert('Error: DIRT report modal not found. Please refresh the page.');
        return;
    }

    let ticket = getCurrentTicket();
    let reportToEdit = null;

    if (eventId) {
        reportToEdit = await findDirtReportByEventId(eventId);
        if (!reportToEdit) {
            void appAlert('Event not found.');
            return;
        }
        window.dirtReportReportType = null;
        window.dirtReportTicketStub = null;
        window.dirtReportEditingTicket = null;
        const link = await resolveDirtReportTicketLink(reportToEdit);
        if (link.status === 'linked' && link.ticket) {
            ticket = link.ticket;
            if (typeof window.selectTicket === 'function') {
                window.selectTicket(ticket.id);
            }
            window.dirtReportTicketStub = null;
        } else {
            ticket = buildDirtReportTicketStub(reportToEdit);
            window.dirtReportTicketStub = ticket;
        }
        window.dirtReportEditingTicket = ticket;
        window.dirtReportEditingEventId = String(
            reportToEdit.id != null && reportToEdit.id !== ''
                ? reportToEdit.id
                : reportToEdit.clientLegacyId != null && reportToEdit.clientLegacyId !== ''
                  ? reportToEdit.clientLegacyId
                  : eventId
        );
    } else {
        window.dirtReportEditingEventId = null;
        window.dirtReportEditingTicket = null;
        window.dirtReportTicketStub = null;
        if (!ticket) {
            void appAlert('No ticket selected. Please select a ticket first by clicking on it on the map.');
            return;
        }
    }

    window.dirtReportCapturedPhotoFileIds = [];
    window.dirtReportLocationManuallySet = false;
    window.dirtReportLocationCleared = false;
    window.dirtReportLocationMapTagged = false;
    window.dirtReportEditingIsDraft = reportToEdit ? reportToEdit.isDraft === true : true;
    content.innerHTML = buildDirtReportForm(ticket);
    modal.style.display = 'flex';
    modal.style.zIndex = '70000'; // Above Manage Data window (60000)
    document.body.style.overflow = 'hidden';

    const now = new Date();
    const dateInput = document.getElementById('dirtIncidentDate');
    const timeInput = document.getElementById('dirtIncidentTime');
    if (dateInput && !reportToEdit) {
        dateInput.value =
            typeof window.getPacificYmd === 'function' ? window.getPacificYmd(now) : now.toISOString().split('T')[0];
    }
    if (timeInput && !reportToEdit) {
        timeInput.value = typeof window.getPacificHm === 'function' ? window.getPacificHm(now) : now.toTimeString().slice(0, 5);
    }

    if (reportToEdit) {
        populateFormFromReport(reportToEdit);
    }

    setupDirtFormListeners();
    updateDirtReportFormActions();
}

// Populate DIRT form from an existing report (for edit mode)
function populateFormFromReport(report) {
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!value;
        else if (value != null) el.value = value;
    };
    set('dirtIncidentDate', report.incidentDate);
    set('dirtIncidentTime', report.incidentTime);
    set('dirtTicketNumber', report.ticketNumber);
    set('dirtAddress', report.address);
    set('dirtCrossStreets', report.crossStreets);
    set('dirtLandmarks', report.landmarks);
    set('dirtWeather', report.weatherConditions);
    set('dirtJobSiteConditions', report.jobSiteConditions);
    set('dirtUtilityType', report.utilityType);
    set('dirtUtilityOwner', report.utilityOwnerName);
    set('dirtSeverity', report.severity);
    set('dirtDamageType', report.damageType);
    set('dirtDescription', report.description);
    set('dirtEquipment', report.equipmentUsed);
    set('dirtDepth', report.utilityDepth);
    set('dirtTechnicianName', report.technicianName);
    set('dirtTechnicianPhone', report.technicianPhone);
    set('dirtTechnicianEmail', report.technicianEmail);
    set('dirtTechnicianSignature', report.technicianSignature);
    set('dirtNotes', report.notes);
    set('dirtFollowUp', report.followUpActions);
    set('dirtSceneSecured', report.sceneSecured);
    set('dirtAreaMarked', report.areaMarked);
    set('dirtWorkStopped', report.workStopped);
    set('dirtEquipmentRemoved', report.equipmentRemoved);
    if (report.emergencyServices) {
        set('dirtEmergencyServices', report.emergencyServices.contacted);
        set('dirtEmergencyTime', report.emergencyServices.timeContacted);
        set('dirtEmergencyName', report.emergencyServices.contactName);
        set('dirtEmergencyPhone', report.emergencyServices.phoneNumber);
        set('dirtEmergencyRef', report.emergencyServices.referenceNumber);
    }
    if (report.utilityOwner) {
        set('dirtUtilityOwnerContacted', report.utilityOwner.contacted);
        set('dirtUtilityTime', report.utilityOwner.timeContacted);
        set('dirtUtilityName', report.utilityOwner.contactName);
        set('dirtUtilityPhone', report.utilityOwner.phoneNumber);
        set('dirtUtilityRef', report.utilityOwner.referenceNumber);
    }
    if (report.oneCallNotified) {
        set('dirtOneCallNotified', report.oneCallNotified.contacted);
        set('dirtOneCallTime', report.oneCallNotified.timeContacted);
        set('dirtOneCallName', report.oneCallNotified.contactName);
        set('dirtOneCallPhone', report.oneCallNotified.phoneNumber);
        set('dirtOneCallRef', report.oneCallNotified.referenceNumber);
    }
    if (report.officialReport) {
        set('dirtOfficialReport', report.officialReport.filed);
        set('dirtOfficialAgency', report.officialReport.agency);
        set('dirtOfficialRef', report.officialReport.referenceNumber);
        set('dirtOfficialDate', report.officialReport.dateFiled);
    }
    if (report.supervisor) {
        set('dirtSupervisorNotified', report.supervisor.notified);
        set('dirtSupervisorName', report.supervisor.name);
        set('dirtSupervisorTime', report.supervisor.timeNotified);
    }
    if (report.location && report.location.lat != null && report.location.lng != null) {
        set('dirtLocationLat', report.location.lat);
        set('dirtLocationLng', report.location.lng);
        const display = document.getElementById('dirtLocationDisplay');
        if (display) display.value = formatLatLng(report.location.lat, report.location.lng);
        const clearBtn = document.getElementById('dirtClearLocationBtn');
        if (clearBtn) clearBtn.style.display = 'inline-block';
        window.dirtReportLocationManuallySet = true;
        window.dirtReportLocationCleared = false;
    } else if (report.locationCleared === true) {
        window.dirtReportLocationManuallySet = true;
        window.dirtReportLocationCleared = true;
    }
    if (Array.isArray(report.photoFileIds) && report.photoFileIds.length) {
        window.dirtReportCapturedPhotoFileIds = report.photoFileIds
            .map(function (id) {
                return Number(id);
            })
            .filter(function (n) {
                return Number.isFinite(n);
            });
        refreshDirtCapturedPhotosList();
    }
}

function updateDirtReportFormActions() {
    const showDraftSave = !window.dirtReportEditingEventId || window.dirtReportEditingIsDraft === true;
    const draftBtn = document.getElementById('dirtSaveDraftBtn');
    const submitBtn = document.getElementById('dirtSubmitReportBtn');
    if (draftBtn) {
        draftBtn.style.display = showDraftSave ? '' : 'none';
    }
    if (submitBtn) {
        const isEdit = !!window.dirtReportEditingEventId;
        submitBtn.textContent =
            isEdit && !showDraftSave ? 'Save Changes' : 'Submit Report';
    }
    const showExport = !!window.dirtReportEditingEventId && window.dirtReportEditingIsDraft === false;
    const exportWrap = document.getElementById('dirtExportReportWrap');
    if (exportWrap) {
        exportWrap.hidden = !showExport;
    }
    updateDirtExportPhotoCheckbox();
}

function updateDirtExportPhotoCheckbox() {
    const photoIds = Array.isArray(window.dirtReportCapturedPhotoFileIds)
        ? window.dirtReportCapturedPhotoFileIds
        : [];
    const includePhotosCb = document.getElementById('dirtExportIncludePhotos');
    if (!includePhotosCb) return;
    includePhotosCb.disabled = photoIds.length === 0;
    if (photoIds.length === 0) {
        includePhotosCb.checked = false;
    }
}

// Open DIRT report modal for editing an existing event (from Data Management Reported Events)
function openDirtReportModalForEvent(eventId) {
    openDirtReportModal(eventId);
}

// Close DIRT report modal
function closeDirtReportModal() {
    const modal = document.getElementById('dirtReportModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
    window.photoUploadAssociationContext = null;
    window.dirtReportReportType = null;
    window.dirtReportTicketStub = null;
    window.dirtReportEditingTicket = null;

    // Clean up temporary location marker if it exists
    if (window.dirtReportModule && window.dirtReportModule.tempLocationMarker && window.map) {
        window.map.removeLayer(window.dirtReportModule.tempLocationMarker);
        window.dirtReportModule.tempLocationMarker = null;
    }
}

function ticketIdMatchesStored(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    if (typeof window.ticketIdEquals === 'function') {
        return window.ticketIdEquals(a, b);
    }
    return String(a) === String(b);
}

// Get current selected ticket (sidebar list passes string ids from HTML; map uses numeric ids from JSON)
function getCurrentTicket() {
    if (window.dirtReportEditingEventId && window.dirtReportEditingTicket) {
        return window.dirtReportEditingTicket;
    }
    if (window.dirtReportTicketStub) {
        return window.dirtReportTicketStub;
    }
    const tickets = window.ORG_TICKETS || [];

    let selectedId = null;
    if (window.ticketsModule) {
        if (typeof window.ticketsModule.selectedTicketId === 'function') {
            selectedId = window.ticketsModule.selectedTicketId();
        } else if (window.ticketsModule.selectedTicketId) {
            selectedId = window.ticketsModule.selectedTicketId;
        }
    }

    if (!selectedId && window.selectedTicketId) {
        selectedId = window.selectedTicketId;
    }

    if (selectedId != null && selectedId !== '') {
        const ticket = tickets.find(t => ticketIdMatchesStored(t.id, selectedId));
        if (ticket) {
            return ticket;
        }
    }

    // Popup may be open from paths that didn’t sync selection, or title is the source of truth while visible
    const popup = document.getElementById('ticketPopup');
    const titleEl = document.getElementById('ticketPopupTitle');
    if (popup && titleEl && popup.classList.contains('show')) {
        const popupTicketId = popup.getAttribute('data-popup-ticket-id');
        if (popupTicketId) {
            const byPopupId = tickets.find((t) => ticketIdMatchesStored(t.id, popupTicketId));
            if (byPopupId) {
                return byPopupId;
            }
        }
        const title = (titleEl.textContent || '').trim();
        const prefix = 'Ticket ';
        if (title.startsWith(prefix)) {
            const num = title.slice(prefix.length).trim();
            if (num) {
                const byNumber = tickets.find((t) => String(t.ticketNumber).trim() === num);
                if (byNumber) {
                    return byNumber;
                }
                if (typeof window.ticketPopupTitleNumberText === 'function') {
                    const byFormatted = tickets.find((t) => window.ticketPopupTitleNumberText(t) === num);
                    if (byFormatted) {
                        return byFormatted;
                    }
                }
            }
        }
    }

    console.error('No ticket selected. Selected ID:', selectedId, 'Available tickets:', tickets.length);
    return null;
}

// Log a minimal event against a ticket and open the USAN portal (no modal).
async function reportEventForTicket(ticket, options) {
    options = options || {};
    if (!ticket) {
        void appAlert('No ticket selected. Please select a ticket first.');
        return false;
    }

    if (
        !options.legacyOnly &&
        !options.usanOnlyStub &&
        typeof window.isTicketRenewalHubEnabled === 'function' &&
        window.isTicketRenewalHubEnabled() &&
        window.ticketReportEventFlow &&
        typeof window.ticketReportEventFlow.openReportEventFromTicket === 'function'
    ) {
        window.ticketReportEventFlow.openReportEventFromTicket(ticket);
        return true;
    }

    let organizationId = null;
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        organizationId = user.organizationId;
    }
    if (typeof window.getCurrentOrgId === 'function' && window.getCurrentOrgId()) {
        organizationId = window.getCurrentOrgId();
    }

    const now = new Date();
    const stub = {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        organizationId: organizationId,
        id: `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        createdAt: now.toISOString(),
        incidentDate: now.toISOString().split('T')[0],
        address: ticket.address || ticket.locationSummary || '',
        technicianSignature: true,
        isDraft: true,
    };

    try {
        if (window.authModule && window.authModule.apiRequest) {
            await window.authModule.apiRequest('data/reported-events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...stub, organizationId: organizationId }),
            });
            if (window.reportedEventsStore) {
                window.reportedEventsStore.invalidate();
                void window.reportedEventsStore.ensureLoaded();
            }
        } else {
            const stored = localStorage.getItem('dirtReports');
            const allReports = stored ? JSON.parse(stored) : [];
            allReports.push(stub);
            localStorage.setItem('dirtReports', JSON.stringify(allReports));
        }
    } catch (error) {
        console.error('Error saving event stub:', error);
        if (!options.usanOnlyStub) {
            void appAlert('Failed to log event. Please try again.');
        }
        return false;
    }

    if (options.usanOnlyStub) {
        return true;
    }

    if (typeof window.openUsanNgenPortalForTicket === 'function') {
        window.openUsanNgenPortalForTicket(ticket);
    } else {
        const usanPortalUrl =
            typeof window.USAN_NGEN_WEB_BASE === 'string' && window.USAN_NGEN_WEB_BASE.trim() !== ''
                ? window.USAN_NGEN_WEB_BASE.trim()
                : 'https://onecallnv.undergroundservicealert.org/ngen.web/';
        window.open(usanPortalUrl, '_blank', 'noopener,noreferrer');
    }

    if (!options.skipTicketPopup && typeof window.showTicketPopup === 'function') {
        window.showTicketPopup(ticket);
    }
    if (typeof window.refreshDataWindow === 'function') {
        window.refreshDataWindow();
    }
    return true;
}

async function reportEventAndOpenOneCall() {
    const ticket = getCurrentTicket();
    if (!ticket) {
        void appAlert('No ticket selected. Please select a ticket first by clicking on it on the map.');
        return;
    }
    await reportEventForTicket(ticket);
}

async function requestSiteDocumentationForCurrentTicket(button) {
    const ticket = getCurrentTicket();
    if (!ticket) {
        await appAlert('No ticket selected. Please select a ticket first by clicking on it on the map.');
        return;
    }
    if (typeof window.openServiceRequestModal === 'function') {
        window.openServiceRequestModal([ticket]);
        return;
    }
    if (typeof window.requestSiteDocumentationForTicket === 'function') {
        window.requestSiteDocumentationForTicket(ticket);
        return;
    }
    await appAlert('Service requests are not available yet. Please try again after the page finishes loading.');
}

const EXTERNAL_SEARCH_TOOL_URL =
    typeof window.EXTERNAL_SEARCH_TOOL_URL === 'string' && window.EXTERNAL_SEARCH_TOOL_URL.trim() !== ''
        ? window.EXTERNAL_SEARCH_TOOL_URL.trim()
        : 'https://appsnv.undergroundservicealert.org/posr/searchtool';

function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve(ok);
    } catch {
        return Promise.resolve(false);
    }
}

/** Copy the ticket number to the clipboard and open external ticket search. */
async function openPosrSearchAndCopy811Ticket(ticketOverride) {
    const ticket =
        ticketOverride && typeof ticketOverride === 'object'
            ? ticketOverride
            : getCurrentTicket();
    if (!ticket) {
        void appAlert('No ticket selected. Please select a ticket first by clicking on it on the map.');
        return;
    }
    const ticketNum = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
    if (!ticketNum) {
        void appAlert('This ticket has no 811 ticket number to copy.');
        return;
    }

    const copied = await copyTextToClipboard(ticketNum);
    if (!copied) {
        void appAlert('Could not copy automatically. Ticket number: ' + ticketNum);
    }

    window.open(EXTERNAL_SEARCH_TOOL_URL, '_blank', 'noopener,noreferrer');
}

// Build DIRT report form HTML
function dirtSectionHtml(sectionId, title, bodyInnerHtml) {
    return (
        '<div class="dirt-section" data-dirt-section="' +
        escapeDirtHtml(sectionId) +
        '">' +
        '<button type="button" class="dirt-section-toggle" aria-expanded="true">' +
        '<span class="dirt-section-chevron" aria-hidden="true"></span>' +
        '<span class="dirt-section-title">' +
        escapeDirtHtml(title) +
        '</span>' +
        '<span class="dirt-section-status dirt-section-status--not-ready" data-dirt-status>Not ready</span>' +
        '</button>' +
        '<div class="dirt-section-body">' +
        bodyInnerHtml +
        '</div>' +
        '</div>'
    );
}

function dirtFieldValue(id) {
    const el = document.getElementById(id);
    if (!el) return '';
    if (el.type === 'checkbox') return el.checked ? '1' : '';
    return String(el.value || '').trim();
}

function isDirtSectionReady(sectionId) {
    switch (sectionId) {
        case 'incident':
            return !!(
                dirtFieldValue('dirtIncidentDate') &&
                dirtFieldValue('dirtIncidentTime') &&
                dirtFieldValue('dirtTicketNumber')
            );
        case 'damage':
            return !!(
                dirtFieldValue('dirtUtilityType') &&
                dirtFieldValue('dirtSeverity') &&
                dirtFieldValue('dirtDamageType') &&
                dirtFieldValue('dirtDescription')
            );
        case 'response':
            return !!(
                dirtFieldValue('dirtEmergencyServices') ||
                dirtFieldValue('dirtUtilityOwnerContacted') ||
                dirtFieldValue('dirtOneCallNotified') ||
                dirtFieldValue('dirtOfficialReport')
            );
        case 'personnel':
            return !!(dirtFieldValue('dirtTechnicianName') && dirtFieldValue('dirtTechnicianSignature'));
        case 'location':
            return !!dirtFieldValue('dirtAddress');
        case 'photos':
            return Array.isArray(window.dirtReportCapturedPhotoFileIds) && window.dirtReportCapturedPhotoFileIds.length > 0;
        case 'additional':
            return !!(dirtFieldValue('dirtNotes') || dirtFieldValue('dirtFollowUp'));
        default:
            return false;
    }
}

function updateDirtSectionStatuses() {
    const form = document.getElementById('dirtReportForm');
    if (!form) return;
    form.querySelectorAll('[data-dirt-section]').forEach(function (section) {
        const id = section.getAttribute('data-dirt-section');
        const ready = isDirtSectionReady(id);
        const badge = section.querySelector('[data-dirt-status]');
        if (badge) {
            badge.textContent = ready ? 'Ready' : 'Not ready';
            badge.classList.toggle('dirt-section-status--ready', ready);
            badge.classList.toggle('dirt-section-status--not-ready', !ready);
        }
        section.classList.toggle('dirt-section--ready', ready);
        section.classList.toggle('dirt-section--not-ready', !ready);
    });
}

function setDirtSectionCollapsed(section, collapsed) {
    if (!section) return;
    section.classList.toggle('is-collapsed', !!collapsed);
    const btn = section.querySelector('.dirt-section-toggle');
    if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function applyDirtSectionInitialCollapse() {
    const form = document.getElementById('dirtReportForm');
    if (!form) return;
    const sections = Array.from(form.querySelectorAll('[data-dirt-section]'));
    let openedIncomplete = false;
    sections.forEach(function (section) {
        const id = section.getAttribute('data-dirt-section');
        const ready = isDirtSectionReady(id);
        if (!ready && !openedIncomplete) {
            setDirtSectionCollapsed(section, false);
            openedIncomplete = true;
        } else {
            setDirtSectionCollapsed(section, true);
        }
    });
    if (!openedIncomplete && sections[0]) {
        setDirtSectionCollapsed(sections[0], false);
    }
}

function setupDirtSectionToggles() {
    const form = document.getElementById('dirtReportForm');
    if (!form) return;
    form.querySelectorAll('.dirt-section-toggle').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const section = btn.closest('[data-dirt-section]');
            if (!section) return;
            setDirtSectionCollapsed(section, !section.classList.contains('is-collapsed'));
        });
    });
}

function buildDirtReportForm(ticket) {
    const ticketNum = ticket.ticketNumber != null ? String(ticket.ticketNumber) : '';
    const incidentBody = `
                <div class="dirt-form-grid">
                    <div class="dirt-form-group">
                        <label>Incident Date *</label>
                        <input type="date" id="dirtIncidentDate" required>
                    </div>
                    <div class="dirt-form-group">
                        <label>Incident Time *</label>
                        <input type="time" id="dirtIncidentTime" required>
                    </div>
                    <div class="dirt-form-group">
                        <label>Ticket Number *</label>
                        <input type="text" id="dirtTicketNumber" value="${escapeDirtHtml(ticketNum)}" readonly required>
                    </div>
                    <div class="dirt-form-group">
                        <label>Weather Conditions</label>
                        <select id="dirtWeather">
                            <option value="">Select...</option>
                            <option value="clear">Clear</option>
                            <option value="cloudy">Cloudy</option>
                            <option value="rain">Rain</option>
                            <option value="snow">Snow</option>
                            <option value="windy">Windy</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div class="dirt-form-group">
                        <label>Job Site Conditions</label>
                        <select id="dirtJobSiteConditions">
                            <option value="">Select...</option>
                            <option value="dry">Dry</option>
                            <option value="wet">Wet</option>
                            <option value="muddy">Muddy</option>
                            <option value="frozen">Frozen</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div class="dirt-form-group">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtSceneSecured">
                            Scene Secured
                        </label>
                    </div>
                    <div class="dirt-form-group">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtAreaMarked">
                            Area Marked
                        </label>
                    </div>
                    <div class="dirt-form-group">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtWorkStopped">
                            Work Stopped
                        </label>
                    </div>
                    <div class="dirt-form-group">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtEquipmentRemoved">
                            Equipment Removed
                        </label>
                    </div>
                </div>`;

    const locationBody = `
                <div class="dirt-form-grid">
                    <div class="dirt-form-group dirt-form-group--full">
                        <label>Location Address *</label>
                        <input type="text" id="dirtAddress" value="${escapeDirtHtml(ticket.address || ticket.locationSummary || '')}" required>
                    </div>
                    <div class="dirt-form-group dirt-form-group--full">
                        <label>Event Location on Map</label>
                        <div class="dirt-location-row">
                            <input type="text" id="dirtLocationDisplay" readonly placeholder="Set on map or from photo GPS">
                            <button type="button" class="dirt-location-btn dirt-location-btn--tag" onclick="tagEventLocationOnMap()">
                                Tag Location
                            </button>
                            <button type="button" class="dirt-location-btn dirt-location-btn--photos" onclick="setDirtEventLocationFromPhotoGps()" id="dirtSetLocationFromPhotosBtn">
                                Set from photo GPS
                            </button>
                            <button type="button" class="dirt-location-btn dirt-location-btn--clear" onclick="clearEventLocation()" id="dirtClearLocationBtn" style="display: none;">
                                Clear
                            </button>
                        </div>
                        <input type="hidden" id="dirtLocationLat">
                        <input type="hidden" id="dirtLocationLng">
                    </div>
                    <div class="dirt-form-group">
                        <label>Cross Streets</label>
                        <input type="text" id="dirtCrossStreets">
                    </div>
                    <div class="dirt-form-group">
                        <label>Landmarks</label>
                        <input type="text" id="dirtLandmarks">
                    </div>
                </div>`;

    const damageBody = `
                <div class="dirt-form-grid">
                    <div class="dirt-form-group">
                        <label>Utility Type *</label>
                        <select id="dirtUtilityType" required>
                            <option value="">Select...</option>
                            <option value="electric">Electric</option>
                            <option value="gas">Gas</option>
                            <option value="water">Water</option>
                            <option value="sewer">Sewer</option>
                            <option value="telecommunications">Telecommunications</option>
                            <option value="oil_fuel">Oil/Fuel</option>
                            <option value="unknown">Unknown</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div class="dirt-form-group">
                        <label>Utility Owner Name</label>
                        <input type="text" id="dirtUtilityOwner" placeholder="Name of utility operator">
                    </div>
                    <div class="dirt-form-group">
                        <label>Damage Severity *</label>
                        <select id="dirtSeverity" required>
                            <option value="minor">Minor</option>
                            <option value="moderate">Moderate</option>
                            <option value="severe">Severe</option>
                        </select>
                    </div>
                    <div class="dirt-form-group">
                        <label>Damage Type *</label>
                        <select id="dirtDamageType" required>
                            <option value="complete_break">Complete Break</option>
                            <option value="partial_damage">Partial Damage</option>
                            <option value="tracer_wire_only">Tracer Wire Only</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div class="dirt-form-group dirt-form-group--full">
                        <label>Damage Description *</label>
                        <textarea id="dirtDescription" rows="4" required placeholder="Describe the damage in detail..."></textarea>
                    </div>
                    <div class="dirt-form-group">
                        <label>Equipment Used</label>
                        <input type="text" id="dirtEquipment" placeholder="e.g., Backhoe, Excavator">
                    </div>
                    <div class="dirt-form-group">
                        <label>Utility Depth (feet)</label>
                        <input type="number" id="dirtDepth" step="0.1" min="0" placeholder="Depth in feet">
                    </div>
                </div>`;

    const responseBody = `
                <div class="dirt-form-grid">
                    <div class="dirt-form-group dirt-form-group--full">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtEmergencyServices">
                            Emergency Services Contacted
                        </label>
                        <div id="dirtEmergencyDetails" style="display: none; margin-top: 0.5rem; padding-left: 1.5rem;">
                            <input type="text" id="dirtEmergencyTime" placeholder="Time contacted" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="text" id="dirtEmergencyName" placeholder="Contact name" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="tel" id="dirtEmergencyPhone" placeholder="Phone number" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="text" id="dirtEmergencyRef" placeholder="Reference number" style="width: 100%;">
                        </div>
                    </div>
                    <div class="dirt-form-group dirt-form-group--full">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtUtilityOwnerContacted">
                            Utility Owner Contacted
                        </label>
                        <div id="dirtUtilityDetails" style="display: none; margin-top: 0.5rem; padding-left: 1.5rem;">
                            <input type="text" id="dirtUtilityTime" placeholder="Time contacted" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="text" id="dirtUtilityName" placeholder="Contact name" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="tel" id="dirtUtilityPhone" placeholder="Phone number" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="text" id="dirtUtilityRef" placeholder="Reference number" style="width: 100%;">
                        </div>
                    </div>
                    <div class="dirt-form-group dirt-form-group--full">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtOneCallNotified">
                            One Call Center Notified
                        </label>
                        <div id="dirtOneCallDetails" style="display: none; margin-top: 0.5rem; padding-left: 1.5rem;">
                            <input type="text" id="dirtOneCallTime" placeholder="Time contacted" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="text" id="dirtOneCallName" placeholder="Contact name" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="tel" id="dirtOneCallPhone" placeholder="Phone number" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="text" id="dirtOneCallRef" placeholder="Reference number" style="width: 100%;">
                        </div>
                    </div>
                    <div class="dirt-form-group dirt-form-group--full">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtOfficialReport">
                            Official Report Filed
                        </label>
                        <div id="dirtOfficialDetails" style="display: none; margin-top: 0.5rem; padding-left: 1.5rem;">
                            <input type="text" id="dirtOfficialAgency" placeholder="Agency name" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="text" id="dirtOfficialRef" placeholder="Reference number" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="date" id="dirtOfficialDate" placeholder="Date filed" style="width: 100%;">
                        </div>
                    </div>
                </div>`;

    const personnelBody = `
                <div class="dirt-form-grid">
                    <div class="dirt-form-group">
                        <label>Technician Name *</label>
                        <input type="text" id="dirtTechnicianName" required autocomplete="name">
                    </div>
                    <div class="dirt-form-group">
                        <label>Technician Phone</label>
                        <input type="tel" id="dirtTechnicianPhone" autocomplete="tel">
                    </div>
                    <div class="dirt-form-group">
                        <label>Technician Email</label>
                        <input type="email" id="dirtTechnicianEmail" autocomplete="email">
                    </div>
                    <div class="dirt-form-group dirt-form-group--full">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtTechnicianSignature" required>
                            I confirm the accuracy of this report *
                        </label>
                    </div>
                    <div class="dirt-form-group dirt-form-group--full">
                        <label class="dirt-check-label">
                            <input type="checkbox" id="dirtSupervisorNotified">
                            Supervisor Notified
                        </label>
                        <div id="dirtSupervisorDetails" style="display: none; margin-top: 0.5rem; padding-left: 1.5rem;">
                            <input type="text" id="dirtSupervisorName" placeholder="Supervisor name" style="margin-bottom: 0.5rem; width: 100%;">
                            <input type="text" id="dirtSupervisorTime" placeholder="Time notified" style="width: 100%;">
                        </div>
                    </div>
                </div>`;

    const photosBody = `
                <div class="dirt-form-grid">
                    <div class="dirt-form-group dirt-form-group--full">
                        <p class="dirt-section-hint">
                            Add damage photos from the camera or your device. Photos without GPS are automatically attached to this ticket.
                        </p>
                        <div class="dirt-photo-actions">
                            <button type="button" id="dirtCapturePhotoBtn" class="button" onclick="startDirtReportPhotoCapture()" style="background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse));">
                                Take photo
                            </button>
                            <button type="button" id="dirtUploadPhotosBtn" class="button" onclick="startDirtReportPhotoUpload()" style="background: var(--app-bg-muted); color: var(--app-text-primary); border: 1px solid var(--app-border);">
                                Upload photos
                            </button>
                            <button type="button" id="dirtChooseGalleryBtn" class="button" onclick="openDirtReportPhotoGalleryModal()" style="background: var(--app-bg-muted); color: var(--app-text-primary); border: 1px solid var(--app-border);">
                                Choose from gallery
                            </button>
                        </div>
                        <ul id="dirtCapturedPhotosList" class="dirt-captured-photos-list"></ul>
                    </div>
                </div>`;

    const additionalBody = `
                <div class="dirt-form-grid">
                    <div class="dirt-form-group dirt-form-group--full">
                        <label>Notes</label>
                        <textarea id="dirtNotes" rows="3" placeholder="Additional notes or comments..."></textarea>
                    </div>
                    <div class="dirt-form-group dirt-form-group--full">
                        <label>Follow-up Actions</label>
                        <textarea id="dirtFollowUp" rows="2" placeholder="Follow-up actions required..."></textarea>
                    </div>
                </div>`;

    return `
        <form id="dirtReportForm" onsubmit="submitDirtReport(event)">
            ${dirtSectionHtml('incident', 'Incident Information', incidentBody)}
            ${dirtSectionHtml('damage', 'Damage Details', damageBody)}
            ${dirtSectionHtml('response', 'Response Actions', responseBody)}
            ${dirtSectionHtml('personnel', 'Personnel', personnelBody)}
            ${dirtSectionHtml('photos', 'Photo Evidence', photosBody)}
            ${dirtSectionHtml('location', 'Location', locationBody)}
            ${dirtSectionHtml('additional', 'Additional Information', additionalBody)}

            <div id="dirtExportReportWrap" class="dirt-export-wrap" hidden>
                <label class="dirt-check-label dirt-export-photos-label">
                    <input type="checkbox" id="dirtExportIncludePhotos">
                    Include photos in export
                </label>
                <button type="button" id="dirtExportReportBtn" class="button" style="background: var(--app-bg-muted); color: var(--app-text-primary); border: 1px solid var(--app-border);">
                    Export Report
                </button>
            </div>

            <!-- Form Actions -->
            <div class="dirt-form-actions">
                <button type="button" class="button" onclick="closeDirtReportModal()" style="background: var(--app-bg-muted); color: var(--app-text-primary);">
                    Cancel
                </button>
                <button type="button" id="dirtSaveDraftBtn" class="button" onclick="saveDirtReportDraft()" style="background: var(--app-bg-surface); color: var(--app-text-primary); border: 1px solid var(--app-border, #555);">
                    Save Draft
                </button>
                <button type="submit" id="dirtSubmitReportBtn" class="button" style="background: var(--app-danger); color: var(--app-text-inverse);">
                    Submit Report
                </button>
            </div>
        </form>
    `;
}

// Setup form event listeners
function setupDirtFormListeners() {
    // Emergency Services
    const emergencyCheck = document.getElementById('dirtEmergencyServices');
    const emergencyDetails = document.getElementById('dirtEmergencyDetails');
    if (emergencyCheck && emergencyDetails) {
        emergencyCheck.onchange = function() {
            emergencyDetails.style.display = this.checked ? 'block' : 'none';
        };
    }
    
    // Utility Owner
    const utilityCheck = document.getElementById('dirtUtilityOwnerContacted');
    const utilityDetails = document.getElementById('dirtUtilityDetails');
    if (utilityCheck && utilityDetails) {
        utilityCheck.onchange = function() {
            utilityDetails.style.display = this.checked ? 'block' : 'none';
        };
    }
    
    // One Call
    const oneCallCheck = document.getElementById('dirtOneCallNotified');
    const oneCallDetails = document.getElementById('dirtOneCallDetails');
    if (oneCallCheck && oneCallDetails) {
        oneCallCheck.onchange = function() {
            oneCallDetails.style.display = this.checked ? 'block' : 'none';
        };
    }
    
    // Official Report
    const officialCheck = document.getElementById('dirtOfficialReport');
    const officialDetails = document.getElementById('dirtOfficialDetails');
    if (officialCheck && officialDetails) {
        officialCheck.onchange = function() {
            officialDetails.style.display = this.checked ? 'block' : 'none';
        };
    }
    
    // Supervisor
    const supervisorCheck = document.getElementById('dirtSupervisorNotified');
    const supervisorDetails = document.getElementById('dirtSupervisorDetails');
    if (supervisorCheck && supervisorDetails) {
        supervisorCheck.onchange = function() {
            supervisorDetails.style.display = this.checked ? 'block' : 'none';
        };
    }

    const captureBtn = document.getElementById('dirtCapturePhotoBtn');
    if (captureBtn) {
        captureBtn.onclick = function () {
            startDirtReportPhotoCapture();
        };
    }
    const uploadBtn = document.getElementById('dirtUploadPhotosBtn');
    if (uploadBtn) {
        uploadBtn.onclick = function () {
            startDirtReportPhotoUpload();
        };
    }
    refreshDirtCapturedPhotosList();

    const exportBtn = document.getElementById('dirtExportReportBtn');
    if (exportBtn) {
        exportBtn.onclick = function () {
            void exportDirtReportFromForm();
        };
    }

    const form = document.getElementById('dirtReportForm');
    if (form) {
        form.addEventListener('input', updateDirtSectionStatuses);
        form.addEventListener('change', function () {
            updateDirtSectionStatuses();
        });
    }
    setupDirtSectionToggles();
    updateDirtSectionStatuses();
    applyDirtSectionInitialCollapse();
}

function updateDirtEventLocationMarker(lat, lng) {
    const map = window.map;
    if (!map || typeof L === 'undefined') return;
    if (window.dirtReportModule && window.dirtReportModule.tempLocationMarker) {
        map.removeLayer(window.dirtReportModule.tempLocationMarker);
    }
    const marker = L.marker(L.latLng(lat, lng), {
        icon: L.divIcon({
            className: 'event-location-marker',
            html: '<div style="background: var(--app-danger); width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
        }),
    });
    marker.addTo(map);
    if (!window.dirtReportModule) {
        window.dirtReportModule = {};
    }
    window.dirtReportModule.tempLocationMarker = marker;
}

function setDirtEventLocationOnForm(lat, lng) {
    const latInput = document.getElementById('dirtLocationLat');
    const lngInput = document.getElementById('dirtLocationLng');
    const displayInput = document.getElementById('dirtLocationDisplay');
    const clearBtn = document.getElementById('dirtClearLocationBtn');
    if (latInput) latInput.value = Number(lat).toFixed(6);
    if (lngInput) lngInput.value = Number(lng).toFixed(6);
    if (displayInput) displayInput.value = formatLatLng(lat, lng);
    if (clearBtn) clearBtn.style.display = 'inline-block';
    updateDirtEventLocationMarker(lat, lng);
    updateDirtSectionStatuses();
}

async function collectGpsPointsForDirtPhotoIds(fileIds) {
    const points = [];
    const ids = (fileIds || [])
        .map(function (id) {
            return Number(id);
        })
        .filter(function (n) {
            return Number.isFinite(n);
        });
    if (!ids.length) return points;

    const savedPhotos =
        window.photosModule && Array.isArray(window.photosModule.savedPhotos)
            ? window.photosModule.savedPhotos
            : [];
    const photoHasCoords =
        window.photoTicketAssociationModule &&
        typeof window.photoTicketAssociationModule.photoHasCoordinates === 'function'
            ? window.photoTicketAssociationModule.photoHasCoordinates
            : null;
    const geo = window.geoGpsAverage || {};
    const extractPhoto = geo.extractPhotoGpsPoint;
    const extractMedia = geo.extractMediaGpsPoint;

    for (let i = 0; i < ids.length; i++) {
        const fileId = ids[i];
        const photo = savedPhotos.find(function (p) {
            return Number(p.fileId) === fileId;
        });
        if (photo && photoHasCoords && photoHasCoords(photo) && extractPhoto) {
            const pt = extractPhoto(photo);
            if (pt) {
                points.push(pt);
                continue;
            }
        }
        if (window.authModule && typeof window.authModule.apiRequest === 'function' && extractMedia) {
            try {
                const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
                const qs =
                    orgId != null && orgId !== ''
                        ? `?organizationId=${encodeURIComponent(String(orgId))}`
                        : '';
                const file = await window.authModule.apiRequest(`data/media/${fileId}${qs}`);
                const pt = extractMedia(file);
                if (pt) points.push(pt);
            } catch (err) {
                console.warn('[dirtReport] media GPS lookup failed for', fileId, err);
            }
        }
    }
    return points;
}

async function syncDirtLocationFromAttachedPhotos() {
    if (window.dirtReportLocationMapTagged) return;
    const fileIds = window.dirtReportCapturedPhotoFileIds;
    if (!Array.isArray(fileIds) || !fileIds.length) return;
    const points = await collectGpsPointsForDirtPhotoIds(fileIds);
    if (!points.length) return;
    const geo = window.geoGpsAverage;
    if (!geo || typeof geo.robustAverageGpsPoints !== 'function') return;
    const avg = geo.robustAverageGpsPoints(points);
    if (!avg || !Number.isFinite(avg.lat) || !Number.isFinite(avg.lng)) return;
    setDirtEventLocationOnForm(avg.lat, avg.lng);
    const gs = window.geocodeSearchModule;
    if (gs && typeof gs.fetchReverseGeocode === 'function') {
        try {
            const result = await gs.fetchReverseGeocode(avg.lat, avg.lng);
            const displayName =
                result && typeof gs.geocodeResultDisplayName === 'function'
                    ? gs.geocodeResultDisplayName(result)
                    : '';
            if (displayName) {
                const addrEl = document.getElementById('dirtAddress');
                if (addrEl) addrEl.value = displayName;
            }
        } catch (err) {
            console.warn('[dirtReport] reverse geocode failed:', err);
        }
    }
    window.dirtReportLocationCleared = false;
    updateDirtSectionStatuses();
}

async function applyDirtEventLocationFromPhotos() {
    if (window.dirtReportLocationManuallySet) return;
    const fileIds = window.dirtReportCapturedPhotoFileIds;
    if (!Array.isArray(fileIds) || !fileIds.length) return;
    const points = await collectGpsPointsForDirtPhotoIds(fileIds);
    if (!points.length) return;
    const geo = window.geoGpsAverage;
    if (!geo || typeof geo.robustAverageGpsPoints !== 'function') return;
    const avg = geo.robustAverageGpsPoints(points);
    if (!avg || !Number.isFinite(avg.lat) || !Number.isFinite(avg.lng)) return;
    setDirtEventLocationOnForm(avg.lat, avg.lng);
}

async function setDirtEventLocationFromPhotoGps() {
    const fileIds = window.dirtReportCapturedPhotoFileIds;
    if (!Array.isArray(fileIds) || !fileIds.length) {
        void appAlert('Add photos with GPS data first.');
        return;
    }
    const points = await collectGpsPointsForDirtPhotoIds(fileIds);
    if (!points.length) {
        void appAlert('No GPS data found in the attached photos.');
        return;
    }
    const geo = window.geoGpsAverage;
    if (!geo || typeof geo.robustAverageGpsPoints !== 'function') {
        void appAlert('Unable to calculate a location from photo GPS.');
        return;
    }
    const avg = geo.robustAverageGpsPoints(points);
    if (!avg || !Number.isFinite(avg.lat) || !Number.isFinite(avg.lng)) {
        void appAlert('No GPS data found in the attached photos.');
        return;
    }
    setDirtEventLocationOnForm(avg.lat, avg.lng);
    window.dirtReportLocationManuallySet = true;
    window.dirtReportLocationCleared = false;
}

function removeDirtCapturedPhoto(fileId) {
    const fid = Number(fileId);
    if (!Number.isFinite(fid)) return;
    const ids = window.dirtReportCapturedPhotoFileIds;
    if (!Array.isArray(ids)) return;
    window.dirtReportCapturedPhotoFileIds = ids.filter(function (id) {
        return Number(id) !== fid;
    });
    refreshDirtCapturedPhotosList();
    void syncDirtLocationFromAttachedPhotos();
}

function openDirtAttachedPhotoViewer(fileId) {
    const fid = Number(fileId);
    if (!Number.isFinite(fid)) return;
    const find = window.photosModule && window.photosModule.findPhotoForUi;
    let photo = find ? find(fid) : null;
    if (!photo) {
        photo = {
            id: 'photo-server-' + fid,
            fileId: fid,
            fileName: 'Photo #' + fid,
        };
    }
    if (typeof window.openPhotoViewer !== 'function') {
        void appAlert('Photo viewer is not available.');
        return;
    }
    window.openPhotoViewer(photo, photo.fileName);
}

function refreshDirtCapturedPhotosList() {
    const list = document.getElementById('dirtCapturedPhotosList');
    if (!list) return;
    const ids = Array.isArray(window.dirtReportCapturedPhotoFileIds) ? window.dirtReportCapturedPhotoFileIds : [];
    if (!ids.length) {
        list.innerHTML = '<li class="dirt-captured-photos-empty">' + escapeDirtHtml('No photos added yet.') + '</li>';
        updateDirtSectionStatuses();
        return;
    }

    const galleryMod = window.dirtReportPhotoGalleryModule;
    list.innerHTML = ids
        .map(function (id) {
            const fid = Number(id);
            const find = window.photosModule && window.photosModule.findPhotoForUi;
            const photo = find && Number.isFinite(fid) ? find(fid) : null;
            const name = photo ? photo.fileName || photo.originalFileName || 'Photo #' + fid : 'Photo #' + fid;
            const date =
                galleryMod && typeof galleryMod.formatPhotoListDate === 'function'
                    ? galleryMod.formatPhotoListDate(photo)
                    : '';
            const badge =
                galleryMod && typeof galleryMod.getMatchedShotBadgeHtml === 'function'
                    ? galleryMod.getMatchedShotBadgeHtml(photo)
                    : '';
            return (
                '<li class="dirt-captured-photo-item" data-file-id="' +
                escapeDirtHtml(String(fid)) +
                '">' +
                '<button type="button" class="dirt-captured-photo-thumb-btn" onclick="openDirtAttachedPhotoViewer(' +
                escapeDirtHtml(String(fid)) +
                ')" title="' +
                escapeDirtHtml(name) +
                '">' +
                '<img class="dirt-captured-photo-thumb" alt="" data-file-id="' +
                escapeDirtHtml(String(fid)) +
                '" />' +
                '</button>' +
                '<div class="dirt-captured-photo-meta">' +
                '<span class="dirt-captured-photo-name">' +
                escapeDirtHtml(name) +
                '</span>' +
                (date ? '<span class="dirt-captured-photo-date">' + escapeDirtHtml(date) + '</span>' : '') +
                badge +
                '</div>' +
                '<button type="button" class="dirt-captured-photo-remove" onclick="removeDirtCapturedPhoto(' +
                escapeDirtHtml(String(fid)) +
                ')" aria-label="Remove photo">×</button>' +
                '</li>'
            );
        })
        .join('');

    list.querySelectorAll('.dirt-captured-photo-thumb').forEach(function (img) {
        const fid = Number(img.getAttribute('data-file-id'));
        const mod = window.photosModule;
        if (!mod || typeof mod.getPhotoThumbnailObjectUrlCached !== 'function' || !Number.isFinite(fid)) return;
        void mod.getPhotoThumbnailObjectUrlCached(fid).then(function (url) {
            if (url) img.src = url;
        });
    });

    updateDirtSectionStatuses();
    updateDirtExportPhotoCheckbox();
}

function hideDirtReportModalForCamera() {
    const modal = document.getElementById('dirtReportModal');
    const wasOpen = !!(modal && modal.style.display !== 'none');
    window._dirtReportModalWasOpenForCamera = wasOpen;
    if (wasOpen && modal) {
        modal.style.display = 'none';
    }
    return wasOpen;
}

function restoreDirtReportModalAfterCamera() {
    if (!window._dirtReportModalWasOpenForCamera) return;
    window._dirtReportModalWasOpenForCamera = false;
    const modal = document.getElementById('dirtReportModal');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.style.zIndex = '70000';
    document.body.style.overflow = 'hidden';
}

function buildDirtReportPhotoUploadContext(ticket) {
    const draftId =
        window.dirtReportEditingEventId ||
        (document.getElementById('dirtReportForm') ? `dirt-draft-${ticket.id}` : null);
    return {
        source: 'dirt',
        ticketId: ticket.id,
        dirtEventId: draftId,
        pendingFileIds: [],
        onPhotoAssociated: function (fileId) {
            if (!Array.isArray(window.dirtReportCapturedPhotoFileIds)) {
                window.dirtReportCapturedPhotoFileIds = [];
            }
            if (!window.dirtReportCapturedPhotoFileIds.includes(fileId)) {
                window.dirtReportCapturedPhotoFileIds.push(fileId);
            }
            refreshDirtCapturedPhotosList();
            void syncDirtLocationFromAttachedPhotos();
        },
    };
}

function applyDirtReportPhotoUploadContext(ticket) {
    if (!ticket) return false;
    window.photoUploadAssociationContext = buildDirtReportPhotoUploadContext(ticket);
    return true;
}

function startDirtReportPhotoCapture() {
    const ticket = getCurrentTicket();
    if (!ticket) {
        void appAlert('No ticket selected.');
        return;
    }
    if (typeof window.initPhotoUploadFromInPageCamera !== 'function') {
        void appAlert('Camera upload is not available yet. Please try again after the page finishes loading.');
        return;
    }
    hideDirtReportModalForCamera();
    applyDirtReportPhotoUploadContext(ticket);
    window.initPhotoUploadFromInPageCamera();
}

function startDirtReportPhotoUpload() {
    const ticket = getCurrentTicket();
    if (!ticket) {
        void appAlert('No ticket selected.');
        return;
    }
    if (typeof window.initPhotoUploadFromGallery !== 'function') {
        void appAlert('Photo upload is not available yet. Please try again after the page finishes loading.');
        return;
    }
    applyDirtReportPhotoUploadContext(ticket);
    // Open the file picker directly (not the source menu, which sat behind the DIRT modal).
    window.initPhotoUploadFromGallery();
}

// Submit DIRT report (create or update when editing)
async function submitDirtReport(event) {
    event.preventDefault();
    await saveDirtReport({ asDraft: false });
}

/** Persist current form without requiring signature / full completion. */
async function saveDirtReportDraft() {
    await saveDirtReport({ asDraft: true });
}

async function saveDirtReport(options) {
    options = options || {};
    const asDraft = !!options.asDraft;
    const isEdit = !!window.dirtReportEditingEventId;
    const ticket = getCurrentTicket();
    if (!ticket) {
        void appAlert('No ticket selected.');
        return;
    }

    // Collect form data
    const reportData = {
        ticketId: ticket.id,
        ticketNumber:
            document.getElementById('dirtTicketNumber')?.value ||
            ticket.ticketNumber ||
            '',

        // Incident Information
        incidentDate: document.getElementById('dirtIncidentDate')?.value || '',
        incidentTime: document.getElementById('dirtIncidentTime')?.value || '',
        address: document.getElementById('dirtAddress')?.value || '',
        crossStreets: document.getElementById('dirtCrossStreets')?.value || '',
        landmarks: document.getElementById('dirtLandmarks')?.value || '',
        weatherConditions: document.getElementById('dirtWeather')?.value || '',
        jobSiteConditions: document.getElementById('dirtJobSiteConditions')?.value || '',

        // Damage Details
        utilityType: document.getElementById('dirtUtilityType')?.value || '',
        utilityOwnerName: document.getElementById('dirtUtilityOwner')?.value || '',
        severity: document.getElementById('dirtSeverity')?.value || '',
        damageType: document.getElementById('dirtDamageType')?.value || '',
        description: document.getElementById('dirtDescription')?.value || '',
        equipmentUsed: document.getElementById('dirtEquipment')?.value || '',
        utilityDepth: document.getElementById('dirtDepth')?.value || '',

        // Response Actions
        emergencyServices: {
            contacted: document.getElementById('dirtEmergencyServices')?.checked || false,
            timeContacted: document.getElementById('dirtEmergencyTime')?.value || '',
            contactName: document.getElementById('dirtEmergencyName')?.value || '',
            phoneNumber: document.getElementById('dirtEmergencyPhone')?.value || '',
            referenceNumber: document.getElementById('dirtEmergencyRef')?.value || ''
        },
        utilityOwner: {
            contacted: document.getElementById('dirtUtilityOwnerContacted')?.checked || false,
            timeContacted: document.getElementById('dirtUtilityTime')?.value || '',
            contactName: document.getElementById('dirtUtilityName')?.value || '',
            phoneNumber: document.getElementById('dirtUtilityPhone')?.value || '',
            referenceNumber: document.getElementById('dirtUtilityRef')?.value || ''
        },
        oneCallNotified: {
            contacted: document.getElementById('dirtOneCallNotified')?.checked || false,
            timeContacted: document.getElementById('dirtOneCallTime')?.value || '',
            contactName: document.getElementById('dirtOneCallName')?.value || '',
            phoneNumber: document.getElementById('dirtOneCallPhone')?.value || '',
            referenceNumber: document.getElementById('dirtOneCallRef')?.value || ''
        },
        officialReport: {
            filed: document.getElementById('dirtOfficialReport')?.checked || false,
            agency: document.getElementById('dirtOfficialAgency')?.value || '',
            referenceNumber: document.getElementById('dirtOfficialRef')?.value || '',
            dateFiled: document.getElementById('dirtOfficialDate')?.value || ''
        },

        // Personnel
        technicianName: document.getElementById('dirtTechnicianName')?.value || '',
        technicianPhone: document.getElementById('dirtTechnicianPhone')?.value || '',
        technicianEmail: document.getElementById('dirtTechnicianEmail')?.value || '',
        technicianSignature: document.getElementById('dirtTechnicianSignature')?.checked || false,
        supervisor: {
            notified: document.getElementById('dirtSupervisorNotified')?.checked || false,
            name: document.getElementById('dirtSupervisorName')?.value || '',
            timeNotified: document.getElementById('dirtSupervisorTime')?.value || ''
        },

        // Scene Information
        sceneSecured: document.getElementById('dirtSceneSecured')?.checked || false,
        areaMarked: document.getElementById('dirtAreaMarked')?.checked || false,
        workStopped: document.getElementById('dirtWorkStopped')?.checked || false,
        equipmentRemoved: document.getElementById('dirtEquipmentRemoved')?.checked || false,

        // Additional Information
        notes: document.getElementById('dirtNotes')?.value || '',
        followUpActions: document.getElementById('dirtFollowUp')?.value || '',

        // Location (if tagged on map)
        location: (() => {
            const lat = document.getElementById('dirtLocationLat')?.value;
            const lng = document.getElementById('dirtLocationLng')?.value;
            if (lat && lng) {
                return {
                    lat: parseFloat(lat),
                    lng: parseFloat(lng)
                };
            }
            return null;
        })(),
        locationCleared: (() => {
            const lat = document.getElementById('dirtLocationLat')?.value;
            const lng = document.getElementById('dirtLocationLng')?.value;
            if (lat && lng) return false;
            return !!window.dirtReportLocationCleared;
        })(),

        photoFileIds: Array.isArray(window.dirtReportCapturedPhotoFileIds)
            ? window.dirtReportCapturedPhotoFileIds.slice()
            : [],

        // Metadata
        isDraft: asDraft,
        ...(window.dirtReportReportType
            ? { reportType: window.dirtReportReportType }
            : isEdit
              ? (() => {
                    const cur = window.reportedEventsStore?.getReportsForCurrentOrg?.() || [];
                    const existing = cur.find(
                        (r) =>
                            String(r.id) === String(window.dirtReportEditingEventId) ||
                            String(r.clientLegacyId) === String(window.dirtReportEditingEventId)
                    );
                    return existing && existing.reportType ? { reportType: existing.reportType } : {};
                })()
              : {}),
        id: isEdit ? window.dirtReportEditingEventId : `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        createdAt: isEdit
            ? (() => {
                  const cur = window.reportedEventsStore?.getReportsForCurrentOrg?.() || [];
                  const existing = cur.find(
                      (r) =>
                          String(r.id) === String(window.dirtReportEditingEventId) ||
                          String(r.clientLegacyId) === String(window.dirtReportEditingEventId)
                  );
                  if (existing && existing.createdAt) return existing.createdAt;
                  try {
                      const stored = localStorage.getItem('dirtReports');
                      const all = stored ? JSON.parse(stored) : [];
                      const e2 = all.find((r, i) => (r.id || `event-${i}`) === window.dirtReportEditingEventId);
                      return e2 ? e2.createdAt || new Date().toISOString() : new Date().toISOString();
                  } catch {
                      return new Date().toISOString();
                  }
              })()
            : new Date().toISOString()
    };

    // Full submit requires signature; drafts can be incomplete.
    if (!asDraft && !reportData.technicianSignature) {
        void appAlert('Please confirm the accuracy of this report by checking the signature box.');
        return;
    }

    const latEl = document.getElementById('dirtLocationLat');
    const lngEl = document.getElementById('dirtLocationLng');
    if ((!latEl || !latEl.value || !lngEl || !lngEl.value) && !window.dirtReportLocationManuallySet && !window.dirtReportLocationCleared) {
        await applyDirtEventLocationFromPhotos();
        const latAfter = document.getElementById('dirtLocationLat')?.value;
        const lngAfter = document.getElementById('dirtLocationLng')?.value;
        if (latAfter && lngAfter) {
            reportData.location = {
                lat: parseFloat(latAfter),
                lng: parseFloat(lngAfter),
            };
        }
    }

    let organizationId = null;
    if (typeof window.getCurrentOrgId === 'function') {
        organizationId = window.getCurrentOrgId();
    } else if (window.authModule && window.authModule.isAuthenticated()) {
        organizationId = window.authModule.getCurrentUser().organizationId;
    }
    reportData.organizationId = organizationId;

    let submitPassword = null;
    if (!asDraft) {
        const editingSubmitted = isEdit && window.dirtReportEditingIsDraft === false;
        const promptMsg = editingSubmitted
            ? 'Enter your account password to save changes to this submitted report.'
            : 'Enter your account password to submit this report.';
        if (typeof window.appPasswordPrompt !== 'function') {
            void appAlert('Password confirmation is not available. Please refresh and try again.');
            return;
        }
        submitPassword = await window.appPasswordPrompt(promptMsg, {
            title: 'Confirm password',
            confirmText: 'Continue',
        });
        if (!submitPassword) return;
    }

    try {
        if (!window.authModule || !window.authModule.apiRequest) {
            throw new Error('Not authenticated');
        }
        if (isEdit) {
            let sid = parseInt(String(window.dirtReportEditingEventId), 10);
            if (!Number.isFinite(sid)) {
                const cur = window.reportedEventsStore?.getReportsForCurrentOrg?.() || [];
                const found = cur.find(
                    (r) =>
                        String(r.id) === String(window.dirtReportEditingEventId) ||
                        String(r.clientLegacyId) === String(window.dirtReportEditingEventId)
                );
                if (found && found.serverId != null) sid = Number(found.serverId);
                else if (found && found.id != null) sid = parseInt(String(found.id), 10);
            }
            if (Number.isFinite(sid)) {
                const apiBody = { ...reportData, organizationId: reportData.organizationId };
                if (submitPassword) apiBody.password = submitPassword;
                await window.authModule.apiRequest(`data/reported-events/${sid}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(apiBody),
                });
            } else {
                const apiBody = {
                    ...reportData,
                    organizationId: reportData.organizationId,
                    clientLegacyId: String(window.dirtReportEditingEventId),
                };
                if (submitPassword) apiBody.password = submitPassword;
                await window.authModule.apiRequest('data/reported-events', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(apiBody),
                });
            }
            window.dirtReportEditingEventId = null;
        } else {
            const apiBody = { ...reportData, organizationId: reportData.organizationId };
            if (submitPassword) apiBody.password = submitPassword;
            await window.authModule.apiRequest('data/reported-events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(apiBody),
            });
        }
        if (window.reportedEventsStore) {
            window.reportedEventsStore.invalidate();
            await window.reportedEventsStore.ensureLoaded();
        }
    } catch (error) {
        console.error('Error saving DIRT report:', error);
        void appAlert(error.message || (asDraft ? 'Failed to save draft.' : 'Failed to save report.'));
        return;
    }

    if (asDraft) {
        void appAlert('Draft saved. Reopen it anytime from Reported Events to finish.');
    } else {
        void appAlert(
            isEdit
                ? 'Event report updated successfully.'
                : 'DIRT report submitted successfully! Report ID: ' + reportData.ticketNumber + '-' + Date.now()
        );
    }
    closeDirtReportModal();
    if (typeof window.refreshDataWindow === 'function') window.refreshDataWindow();
}

// Tag event location on map
function tagEventLocationOnMap() {
    const map = window.map;
    if (!map) {
        void appAlert('Map not available.');
        return;
    }
    
    // Close modal temporarily
    const modal = document.getElementById('dirtReportModal');
    const wasVisible = modal && modal.style.display !== 'none';
    if (wasVisible) {
        modal.style.display = 'none';
    }
    
    // Cancel any active drawing or measuring
    if (window.drawingModule && window.drawingModule.currentDrawingMode) {
        window.drawingModule.cancelDrawingMode();
    }
    if (window.measureModule && window.measureModule.cancelMeasureMode) {
        window.measureModule.cancelMeasureMode();
    }
    if (window.photosModule && window.photosModule.photoUploadMode && window.photosModule.cancelPhotoUpload) {
        window.photosModule.cancelPhotoUpload();
    }
    
    // Enable location tagging mode
    map.getContainer().style.cursor = 'crosshair';
    
    // Remove any existing temporary marker
    if (window.dirtReportModule && window.dirtReportModule.tempLocationMarker) {
        map.removeLayer(window.dirtReportModule.tempLocationMarker);
    }
    
    // Add click handler for location tagging
    const tagHandler = function(e) {
        L.DomEvent.stopPropagation(e);
        
        // Update form fields
        const latInput = document.getElementById('dirtLocationLat');
        const lngInput = document.getElementById('dirtLocationLng');
        const displayInput = document.getElementById('dirtLocationDisplay');
        const clearBtn = document.getElementById('dirtClearLocationBtn');
        
        if (latInput && lngInput && displayInput) {
            latInput.value = e.latlng.lat.toFixed(6);
            lngInput.value = e.latlng.lng.toFixed(6);
            displayInput.value = formatLatLng(e.latlng.lat, e.latlng.lng);

            if (clearBtn) {
                clearBtn.style.display = 'block';
            }
        }

        window.dirtReportLocationManuallySet = true;
        window.dirtReportLocationCleared = false;
        window.dirtReportLocationMapTagged = true;
        
        // Remove old temporary marker if exists
        if (window.dirtReportModule && window.dirtReportModule.tempLocationMarker) {
            map.removeLayer(window.dirtReportModule.tempLocationMarker);
        }
        
        // Create temporary marker
        const marker = L.marker(e.latlng, {
            icon: L.divIcon({
                className: 'event-location-marker',
                html: '<div style="background: var(--app-danger); width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            })
        });
        marker.addTo(map);
        
        // Store marker reference
        if (!window.dirtReportModule) {
            window.dirtReportModule = {};
        }
        window.dirtReportModule.tempLocationMarker = marker;
        
        // Remove click handler
        map.off('click', tagHandler);
        map.getContainer().style.cursor = '';
        
        // Reopen modal if it was visible
        if (wasVisible && modal) {
            modal.style.display = 'flex';
        }
        
        void appAlert('Location tagged successfully!');
    };
    
    map.on('click', tagHandler);
    
    // Show message
    void appAlert('Click on the map to tag the event location.');
}

// Clear event location
function clearEventLocation() {
    const latInput = document.getElementById('dirtLocationLat');
    const lngInput = document.getElementById('dirtLocationLng');
    const displayInput = document.getElementById('dirtLocationDisplay');
    const clearBtn = document.getElementById('dirtClearLocationBtn');
    
    if (latInput) latInput.value = '';
    if (lngInput) lngInput.value = '';
    if (displayInput) displayInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    // User explicitly cleared — do not auto-fill from photo GPS again.
    window.dirtReportLocationManuallySet = true;
    window.dirtReportLocationCleared = true;
    window.dirtReportLocationMapTagged = false;

    // Remove temporary marker from map
    if (window.dirtReportModule && window.dirtReportModule.tempLocationMarker && window.map) {
        window.map.removeLayer(window.dirtReportModule.tempLocationMarker);
        window.dirtReportModule.tempLocationMarker = null;
    }

    updateDirtSectionStatuses();
}

function dirtExportYesNo(value) {
    return value ? 'Yes' : 'No';
}

function dirtExportText(value) {
    if (value == null || value === '') return '—';
    return String(value);
}

function resolveDirtPhotoExportNames(fileIds) {
    const names = [];
    const find = window.photosModule && window.photosModule.findPhotoForUi;
    (fileIds || []).forEach(function (id) {
        const fid = Number(id);
        if (!Number.isFinite(fid)) return;
        const photo = find ? find(fid) : null;
        const name = photo
            ? photo.fileName || photo.originalFileName || 'Photo #' + fid
            : 'Photo #' + fid;
        names.push(name);
    });
    return names;
}

function collectDirtReportFormData() {
    const ticket = getCurrentTicket();
    const lat = document.getElementById('dirtLocationLat')?.value || '';
    const lng = document.getElementById('dirtLocationLng')?.value || '';
    const photoFileIds = Array.isArray(window.dirtReportCapturedPhotoFileIds)
        ? window.dirtReportCapturedPhotoFileIds.slice()
        : [];
    return {
        ticketNumber:
            document.getElementById('dirtTicketNumber')?.value ||
            (ticket && ticket.ticketNumber) ||
            '',
        incidentDate: document.getElementById('dirtIncidentDate')?.value || '',
        incidentTime: document.getElementById('dirtIncidentTime')?.value || '',
        weatherConditions: document.getElementById('dirtWeather')?.value || '',
        jobSiteConditions: document.getElementById('dirtJobSiteConditions')?.value || '',
        sceneSecured: document.getElementById('dirtSceneSecured')?.checked || false,
        areaMarked: document.getElementById('dirtAreaMarked')?.checked || false,
        workStopped: document.getElementById('dirtWorkStopped')?.checked || false,
        equipmentRemoved: document.getElementById('dirtEquipmentRemoved')?.checked || false,
        utilityType: document.getElementById('dirtUtilityType')?.value || '',
        utilityOwnerName: document.getElementById('dirtUtilityOwner')?.value || '',
        severity: document.getElementById('dirtSeverity')?.value || '',
        damageType: document.getElementById('dirtDamageType')?.value || '',
        description: document.getElementById('dirtDescription')?.value || '',
        equipmentUsed: document.getElementById('dirtEquipment')?.value || '',
        utilityDepth: document.getElementById('dirtDepth')?.value || '',
        emergencyServices: {
            contacted: document.getElementById('dirtEmergencyServices')?.checked || false,
            timeContacted: document.getElementById('dirtEmergencyTime')?.value || '',
            contactName: document.getElementById('dirtEmergencyName')?.value || '',
            phoneNumber: document.getElementById('dirtEmergencyPhone')?.value || '',
            referenceNumber: document.getElementById('dirtEmergencyRef')?.value || '',
        },
        utilityOwner: {
            contacted: document.getElementById('dirtUtilityOwnerContacted')?.checked || false,
            timeContacted: document.getElementById('dirtUtilityTime')?.value || '',
            contactName: document.getElementById('dirtUtilityName')?.value || '',
            phoneNumber: document.getElementById('dirtUtilityPhone')?.value || '',
            referenceNumber: document.getElementById('dirtUtilityRef')?.value || '',
        },
        oneCallNotified: {
            contacted: document.getElementById('dirtOneCallNotified')?.checked || false,
            timeContacted: document.getElementById('dirtOneCallTime')?.value || '',
            contactName: document.getElementById('dirtOneCallName')?.value || '',
            phoneNumber: document.getElementById('dirtOneCallPhone')?.value || '',
            referenceNumber: document.getElementById('dirtOneCallRef')?.value || '',
        },
        officialReport: {
            filed: document.getElementById('dirtOfficialReport')?.checked || false,
            agency: document.getElementById('dirtOfficialAgency')?.value || '',
            referenceNumber: document.getElementById('dirtOfficialRef')?.value || '',
            dateFiled: document.getElementById('dirtOfficialDate')?.value || '',
        },
        technicianName: document.getElementById('dirtTechnicianName')?.value || '',
        technicianPhone: document.getElementById('dirtTechnicianPhone')?.value || '',
        technicianEmail: document.getElementById('dirtTechnicianEmail')?.value || '',
        technicianSignature: document.getElementById('dirtTechnicianSignature')?.checked || false,
        supervisor: {
            notified: document.getElementById('dirtSupervisorNotified')?.checked || false,
            name: document.getElementById('dirtSupervisorName')?.value || '',
            timeNotified: document.getElementById('dirtSupervisorTime')?.value || '',
        },
        address: document.getElementById('dirtAddress')?.value || '',
        crossStreets: document.getElementById('dirtCrossStreets')?.value || '',
        landmarks: document.getElementById('dirtLandmarks')?.value || '',
        location: lat && lng ? { lat: parseFloat(lat), lng: parseFloat(lng) } : null,
        notes: document.getElementById('dirtNotes')?.value || '',
        followUpActions: document.getElementById('dirtFollowUp')?.value || '',
        photoFileIds: photoFileIds,
        photoFileNames: resolveDirtPhotoExportNames(photoFileIds),
        submittedAt: (function () {
            if (!window.dirtReportEditingEventId || window.dirtReportEditingIsDraft !== false) {
                return null;
            }
            const cur =
                window.reportedEventsStore && window.reportedEventsStore.getReportsForCurrentOrg
                    ? window.reportedEventsStore.getReportsForCurrentOrg()
                    : [];
            const existing = (cur || []).find(function (r) {
                return (
                    String(r.id) === String(window.dirtReportEditingEventId) ||
                    String(r.clientLegacyId) === String(window.dirtReportEditingEventId)
                );
            });
            if (existing && (existing.updatedAt || existing.createdAt)) {
                return existing.updatedAt || existing.createdAt;
            }
            return null;
        })(),
    };
}

function buildDirtReportExportDataFromReport(report) {
    const photoFileIds = Array.isArray(report.photoFileIds) ? report.photoFileIds.slice() : [];
    return {
        ticketNumber: report.ticketNumber || '',
        incidentDate: report.incidentDate || '',
        incidentTime: report.incidentTime || '',
        weatherConditions: report.weatherConditions || '',
        jobSiteConditions: report.jobSiteConditions || '',
        sceneSecured: !!report.sceneSecured,
        areaMarked: !!report.areaMarked,
        workStopped: !!report.workStopped,
        equipmentRemoved: !!report.equipmentRemoved,
        utilityType: report.utilityType || '',
        utilityOwnerName: report.utilityOwnerName || '',
        severity: report.severity || '',
        damageType: report.damageType || '',
        description: report.description || '',
        equipmentUsed: report.equipmentUsed || '',
        utilityDepth: report.utilityDepth || '',
        emergencyServices: report.emergencyServices || {},
        utilityOwner: report.utilityOwner || {},
        oneCallNotified: report.oneCallNotified || {},
        officialReport: report.officialReport || {},
        technicianName: report.technicianName || '',
        technicianPhone: report.technicianPhone || '',
        technicianEmail: report.technicianEmail || '',
        technicianSignature: !!report.technicianSignature,
        supervisor: report.supervisor || {},
        address: report.address || '',
        crossStreets: report.crossStreets || '',
        landmarks: report.landmarks || '',
        location: report.location || null,
        notes: report.notes || '',
        followUpActions: report.followUpActions || '',
        photoFileIds: photoFileIds,
        photoFileNames: resolveDirtPhotoExportNames(photoFileIds),
        submittedAt: report.updatedAt || report.createdAt || null,
    };
}

function dirtExportContactRows(label, block) {
    block = block || {};
    return (
        '<tr><td colspan="2"><strong>' +
        escapeDirtHtml(label) +
        '</strong></td></tr>' +
        '<tr><td>Contacted</td><td>' +
        escapeDirtHtml(dirtExportYesNo(block.contacted)) +
        '</td></tr>' +
        '<tr><td>Time</td><td>' +
        escapeDirtHtml(dirtExportText(block.timeContacted)) +
        '</td></tr>' +
        '<tr><td>Contact name</td><td>' +
        escapeDirtHtml(dirtExportText(block.contactName)) +
        '</td></tr>' +
        '<tr><td>Phone</td><td>' +
        escapeDirtHtml(dirtExportText(block.phoneNumber)) +
        '</td></tr>' +
        '<tr><td>Reference</td><td>' +
        escapeDirtHtml(dirtExportText(block.referenceNumber)) +
        '</td></tr>'
    );
}

function buildDirtReportExportHtml(data) {
    data = data || {};
    const loc =
        data.location && data.location.lat != null && data.location.lng != null
            ? Number(data.location.lat).toFixed(6) + ', ' + Number(data.location.lng).toFixed(6)
            : '—';
    const photoNames = Array.isArray(data.photoFileNames) ? data.photoFileNames : [];
    const photoList =
        photoNames.length > 0
            ? '<ul style="margin:0;padding-left:1.25rem;">' +
              photoNames
                  .map(function (name) {
                      return '<li>' + escapeDirtHtml(name) + '</li>';
                  })
                  .join('') +
              '</ul>'
            : '—';

    return (
        '<div style="font-family:Arial,sans-serif;font-size:12px;line-height:1.45;color:#111;">' +
        '<h1 style="font-size:18px;margin:0 0 8px;">DIRT Report</h1>' +
        '<p style="margin:0 0 16px;">Ticket ' +
        escapeDirtHtml(dirtExportText(data.ticketNumber)) +
        (data.submittedAt
            ? ' · Submitted ' + escapeDirtHtml(String(data.submittedAt).slice(0, 10))
            : '') +
        '</p>' +
        '<h2 style="font-size:14px;margin:16px 0 6px;">Incident Information</h2>' +
        '<table style="width:100%;border-collapse:collapse;" border="1" cellpadding="6">' +
        '<tr><td>Date</td><td>' +
        escapeDirtHtml(dirtExportText(data.incidentDate)) +
        '</td></tr>' +
        '<tr><td>Time</td><td>' +
        escapeDirtHtml(dirtExportText(data.incidentTime)) +
        '</td></tr>' +
        '<tr><td>Weather</td><td>' +
        escapeDirtHtml(dirtExportText(data.weatherConditions)) +
        '</td></tr>' +
        '<tr><td>Job site conditions</td><td>' +
        escapeDirtHtml(dirtExportText(data.jobSiteConditions)) +
        '</td></tr>' +
        '<tr><td>Scene secured</td><td>' +
        escapeDirtHtml(dirtExportYesNo(data.sceneSecured)) +
        '</td></tr>' +
        '<tr><td>Area marked</td><td>' +
        escapeDirtHtml(dirtExportYesNo(data.areaMarked)) +
        '</td></tr>' +
        '<tr><td>Work stopped</td><td>' +
        escapeDirtHtml(dirtExportYesNo(data.workStopped)) +
        '</td></tr>' +
        '<tr><td>Equipment removed</td><td>' +
        escapeDirtHtml(dirtExportYesNo(data.equipmentRemoved)) +
        '</td></tr>' +
        '</table>' +
        '<h2 style="font-size:14px;margin:16px 0 6px;">Damage Details</h2>' +
        '<table style="width:100%;border-collapse:collapse;" border="1" cellpadding="6">' +
        '<tr><td>Utility type</td><td>' +
        escapeDirtHtml(dirtExportText(data.utilityType)) +
        '</td></tr>' +
        '<tr><td>Utility owner</td><td>' +
        escapeDirtHtml(dirtExportText(data.utilityOwnerName)) +
        '</td></tr>' +
        '<tr><td>Severity</td><td>' +
        escapeDirtHtml(dirtExportText(data.severity)) +
        '</td></tr>' +
        '<tr><td>Damage type</td><td>' +
        escapeDirtHtml(dirtExportText(data.damageType)) +
        '</td></tr>' +
        '<tr><td>Description</td><td>' +
        escapeDirtHtml(dirtExportText(data.description)) +
        '</td></tr>' +
        '<tr><td>Equipment used</td><td>' +
        escapeDirtHtml(dirtExportText(data.equipmentUsed)) +
        '</td></tr>' +
        '<tr><td>Utility depth</td><td>' +
        escapeDirtHtml(dirtExportText(data.utilityDepth)) +
        '</td></tr>' +
        '</table>' +
        '<h2 style="font-size:14px;margin:16px 0 6px;">Response Actions</h2>' +
        '<table style="width:100%;border-collapse:collapse;" border="1" cellpadding="6">' +
        dirtExportContactRows('Emergency services', data.emergencyServices) +
        dirtExportContactRows('Utility owner', data.utilityOwner) +
        dirtExportContactRows('One Call', data.oneCallNotified) +
        '<tr><td colspan="2"><strong>Official report</strong></td></tr>' +
        '<tr><td>Filed</td><td>' +
        escapeDirtHtml(dirtExportYesNo(data.officialReport && data.officialReport.filed)) +
        '</td></tr>' +
        '<tr><td>Agency</td><td>' +
        escapeDirtHtml(dirtExportText(data.officialReport && data.officialReport.agency)) +
        '</td></tr>' +
        '<tr><td>Reference</td><td>' +
        escapeDirtHtml(dirtExportText(data.officialReport && data.officialReport.referenceNumber)) +
        '</td></tr>' +
        '<tr><td>Date filed</td><td>' +
        escapeDirtHtml(dirtExportText(data.officialReport && data.officialReport.dateFiled)) +
        '</td></tr>' +
        '</table>' +
        '<h2 style="font-size:14px;margin:16px 0 6px;">Personnel</h2>' +
        '<table style="width:100%;border-collapse:collapse;" border="1" cellpadding="6">' +
        '<tr><td>Technician</td><td>' +
        escapeDirtHtml(dirtExportText(data.technicianName)) +
        '</td></tr>' +
        '<tr><td>Phone</td><td>' +
        escapeDirtHtml(dirtExportText(data.technicianPhone)) +
        '</td></tr>' +
        '<tr><td>Email</td><td>' +
        escapeDirtHtml(dirtExportText(data.technicianEmail)) +
        '</td></tr>' +
        '<tr><td>Signature confirmed</td><td>' +
        escapeDirtHtml(dirtExportYesNo(data.technicianSignature)) +
        '</td></tr>' +
        '<tr><td>Supervisor notified</td><td>' +
        escapeDirtHtml(dirtExportYesNo(data.supervisor && data.supervisor.notified)) +
        '</td></tr>' +
        '<tr><td>Supervisor name</td><td>' +
        escapeDirtHtml(dirtExportText(data.supervisor && data.supervisor.name)) +
        '</td></tr>' +
        '<tr><td>Supervisor time</td><td>' +
        escapeDirtHtml(dirtExportText(data.supervisor && data.supervisor.timeNotified)) +
        '</td></tr>' +
        '</table>' +
        '<h2 style="font-size:14px;margin:16px 0 6px;">Location</h2>' +
        '<table style="width:100%;border-collapse:collapse;" border="1" cellpadding="6">' +
        '<tr><td>Address</td><td>' +
        escapeDirtHtml(dirtExportText(data.address)) +
        '</td></tr>' +
        '<tr><td>GPS coordinates</td><td>' +
        escapeDirtHtml(loc) +
        '</td></tr>' +
        '<tr><td>Cross streets</td><td>' +
        escapeDirtHtml(dirtExportText(data.crossStreets)) +
        '</td></tr>' +
        '<tr><td>Landmarks</td><td>' +
        escapeDirtHtml(dirtExportText(data.landmarks)) +
        '</td></tr>' +
        '</table>' +
        '<h2 style="font-size:14px;margin:16px 0 6px;">Photos</h2>' +
        '<p style="margin:0 0 4px;">Count: ' +
        escapeDirtHtml(String(photoNames.length)) +
        '</p>' +
        photoList +
        '<h2 style="font-size:14px;margin:16px 0 6px;">Additional Information</h2>' +
        '<table style="width:100%;border-collapse:collapse;" border="1" cellpadding="6">' +
        '<tr><td>Notes</td><td>' +
        escapeDirtHtml(dirtExportText(data.notes)) +
        '</td></tr>' +
        '<tr><td>Follow-up actions</td><td>' +
        escapeDirtHtml(dirtExportText(data.followUpActions)) +
        '</td></tr>' +
        '</table>' +
        '</div>'
    );
}

function downloadDirtExportBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function dirtExportBaseFilename(data) {
    const ticket = (data && data.ticketNumber ? String(data.ticketNumber) : 'report').replace(/[^\w.-]+/g, '_');
    const date = (data && data.incidentDate ? String(data.incidentDate) : 'date').replace(/[^\w.-]+/g, '_');
    return 'DIRT-' + ticket + '-' + date;
}

async function exportDirtReportData(data, options) {
    options = options || {};
    const includePhotos = !!options.includePhotos;
    if (typeof window.__dirtReportExportToPdfBytes !== 'function') {
        void appAlert('PDF export is not available. Please refresh the page.');
        return;
    }

    const exportBtn = document.getElementById('dirtExportReportBtn');
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.textContent = 'Exporting…';
    }

    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '-12000px';
    container.style.top = '0';
    container.style.width = '720px';
    container.style.padding = '24px';
    container.style.background = '#ffffff';
    container.innerHTML = buildDirtReportExportHtml(data);
    document.body.appendChild(container);

    try {
        const pdfBytes = await window.__dirtReportExportToPdfBytes(container);
        const baseName = dirtExportBaseFilename(data);
        const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });

        if (!includePhotos) {
            downloadDirtExportBlob(pdfBlob, baseName + '.pdf');
            return;
        }

        if (typeof JSZip === 'undefined') {
            void appAlert('ZIP export is not available. Downloading PDF only.');
            downloadDirtExportBlob(pdfBlob, baseName + '.pdf');
            return;
        }

        const photosModule = window.photosModule;
        if (!photosModule || typeof photosModule.blobFromPhotoForExport !== 'function') {
            void appAlert('Photo export helpers not loaded. Downloading PDF only.');
            downloadDirtExportBlob(pdfBlob, baseName + '.pdf');
            return;
        }

        const zip = new JSZip();
        zip.file(baseName + '.pdf', pdfBytes);
        const photoIds = Array.isArray(data.photoFileIds) ? data.photoFileIds : [];
        const find = photosModule.findPhotoForUi;
        let failedPhotos = 0;
        for (let i = 0; i < photoIds.length; i++) {
            const fid = Number(photoIds[i]);
            if (!Number.isFinite(fid)) continue;
            const photo =
                find && typeof find === 'function'
                    ? find(fid)
                    : { fileId: fid, fileName: 'Photo-' + fid + '.jpg' };
            if (!photo) {
                failedPhotos += 1;
                continue;
            }
            try {
                const blob = await photosModule.blobFromPhotoForExport(photo);
                const fileName =
                    photo.fileName || photo.originalFileName || 'Photo-' + fid + '.jpg';
                zip.file('photos/' + fileName.replace(/[/\\]/g, '_'), blob);
            } catch (err) {
                failedPhotos += 1;
                console.warn('[dirtReport] photo export failed for', fid, err);
            }
        }
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        downloadDirtExportBlob(zipBlob, baseName + '.zip');
        if (failedPhotos > 0) {
            void appAlert(
                'Export finished, but ' +
                    failedPhotos +
                    ' photo(s) could not be included. The PDF is still in the ZIP.'
            );
        }
    } catch (err) {
        console.error('[dirtReport] export failed:', err);
        void appAlert(err.message || 'Failed to export report.');
    } finally {
        document.body.removeChild(container);
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.textContent = 'Export Report';
        }
    }
}

function promptDirtReportExportOptions(hasPhotos) {
    return new Promise(function (resolve) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.style.zIndex = '75001';
        overlay.innerHTML =
            '<div class="modal-content" style="max-width:24rem;padding:1.25rem;">' +
            '<h3 style="margin:0 0 1rem;">Export Report</h3>' +
            '<label class="dirt-check-label" style="display:block;margin-bottom:1rem;">' +
            '<input type="checkbox" id="dirtExportDlgIncludePhotos"' +
            (hasPhotos ? '' : ' disabled') +
            '> Include photos in export</label>' +
            '<div style="display:flex;gap:0.5rem;justify-content:flex-end;">' +
            '<button type="button" class="button" data-dirt-export-action="cancel">Cancel</button>' +
            '<button type="button" class="button" data-dirt-export-action="export" style="background:var(--app-accent);color:var(--app-text-inverse);">Export</button>' +
            '</div></div>';

        function cleanup(result) {
            overlay.remove();
            resolve(result);
        }

        overlay.addEventListener('click', function (e) {
            const action = e.target && e.target.getAttribute && e.target.getAttribute('data-dirt-export-action');
            if (action === 'cancel') {
                cleanup(null);
                return;
            }
            if (action === 'export') {
                const cb = overlay.querySelector('#dirtExportDlgIncludePhotos');
                cleanup({ includePhotos: !!(cb && cb.checked) });
            }
        });

        document.body.appendChild(overlay);
    });
}

async function exportDirtReportFromForm() {
    if (!window.dirtReportEditingEventId || window.dirtReportEditingIsDraft !== false) {
        void appAlert('Export is available for submitted reports only.');
        return;
    }
    const includePhotos = !!document.getElementById('dirtExportIncludePhotos')?.checked;
    await exportDirtReportData(collectDirtReportFormData(), { includePhotos: includePhotos });
}

async function exportDirtReportForEvent(eventId) {
    const report = await findDirtReportByEventId(eventId);
    if (!report) {
        void appAlert('Event not found.');
        return;
    }
    if (report.isDraft === true) {
        void appAlert('Draft reports cannot be exported.');
        return;
    }
    const hasPhotos = Array.isArray(report.photoFileIds) && report.photoFileIds.length > 0;
    const opts = await promptDirtReportExportOptions(hasPhotos);
    if (!opts) return;
    await exportDirtReportData(buildDirtReportExportDataFromReport(report), {
        includePhotos: opts.includePhotos,
    });
}

// Export for use in other modules
window.dirtReportModule = {
    openDirtReportModal,
    openDirtReportModalForEvent,
    closeDirtReportModal,
    reportEventAndOpenOneCall,
    reportEventForTicket,
    requestSiteDocumentationForCurrentTicket,
    openPosrSearchAndCopy811Ticket,
    submitDirtReport,
    saveDirtReportDraft,
    tagEventLocationOnMap,
    clearEventLocation,
    setDirtEventLocationFromPhotoGps,
    exportDirtReportForEvent,
    exportDirtReportData,
    collectDirtReportFormData,
    buildDirtReportExportDataFromReport,
    resolveDirtReportTicketLink,
    getDirtReportTicketLinkStatus,
    explainMissingDirtReportTicketForEvent,
    invalidateDirtReportTicketLinkCache,
    openDirtReportPhotoGalleryModal:
        window.dirtReportPhotoGalleryModule &&
        typeof window.dirtReportPhotoGalleryModule.openDirtReportPhotoGalleryModal === 'function'
            ? window.dirtReportPhotoGalleryModule.openDirtReportPhotoGalleryModal
            : undefined,
};

// Make functions globally available for HTML onclick handlers
window.openDirtReportModal = openDirtReportModal;
window.openDirtReportModalForEvent = openDirtReportModalForEvent;
window.closeDirtReportModal = closeDirtReportModal;
window.reportEventAndOpenOneCall = reportEventAndOpenOneCall;
window.reportEventForTicket = reportEventForTicket;
window.requestSiteDocumentationForCurrentTicket = requestSiteDocumentationForCurrentTicket;
window.openPosrSearchAndCopy811Ticket = openPosrSearchAndCopy811Ticket;
window.submitDirtReport = submitDirtReport;
window.saveDirtReportDraft = saveDirtReportDraft;
window.tagEventLocationOnMap = tagEventLocationOnMap;
window.clearEventLocation = clearEventLocation;
window.setDirtEventLocationFromPhotoGps = setDirtEventLocationFromPhotoGps;
window.exportDirtReportForEvent = exportDirtReportForEvent;
window.startDirtReportPhotoCapture = startDirtReportPhotoCapture;
window.startDirtReportPhotoUpload = startDirtReportPhotoUpload;
window.restoreDirtReportModalAfterCamera = restoreDirtReportModalAfterCamera;
window.removeDirtCapturedPhoto = removeDirtCapturedPhoto;
window.openDirtAttachedPhotoViewer = openDirtAttachedPhotoViewer;

