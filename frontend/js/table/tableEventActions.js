/**
 * tableEventActions.js — split from tableActions.js (Phase F4).
 * Reported events modal, map marker, location drawing.
 */
// Table actions module - CRUD operations for all data types

function getDirtReportsForCurrentOrgUnified() {
    let currentOrgId = null;
    if (window.authModule && window.authModule.isAuthenticated()) {
        currentOrgId = window.authModule.getCurrentUser().organizationId;
    }
    if (window.reportedEventsStore && typeof window.reportedEventsStore.getReportsForCurrentOrg === 'function') {
        const apiList = window.reportedEventsStore.getReportsForCurrentOrg();
        if (apiList.length > 0) return apiList;
    }
    try {
        const allReports = JSON.parse(localStorage.getItem('dirtReports') || '[]');
        return allReports.filter((report) => report.organizationId === currentOrgId);
    } catch (error) {
        console.error('Error loading DIRT reports:', error);
        return [];
    }
}

function findDirtReportByStableId(eventId) {
    const reports = getDirtReportsForCurrentOrgUnified();
    return reports.find(
        (r, index) =>
            String(r.id) === String(eventId) ||
            String(r.clientLegacyId) === String(eventId) ||
            (r.id || `event-${index}`) === eventId
    );
}

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

// View event details
async function viewEvent(eventId) {
    // Cancel any active event location drawing to prevent conflicts
    if (window.eventLocationDrawing && window.cancelEventLocationDrawing) {
        window.cancelEventLocationDrawing();
    }
    
    // Remove any existing event location confirmation dialog
    const existingConfirm = document.getElementById('eventLocationConfirm');
    if (existingConfirm && existingConfirm.parentNode) {
        existingConfirm.parentNode.removeChild(existingConfirm);
    }

    const report = findDirtReportByStableId(eventId);
    if (!report) {
        await appAlert('Event not found.');
        return;
    }
    
    // Get modal elements
    const modal = document.getElementById('eventDetailsModal');
    const content = document.getElementById('eventDetailsContent');
    
    if (!modal || !content) {
        console.error('Event details modal not found');
        return;
    }
    
    const eventText = (value, fallback = '—') =>
        escapeHtml(value == null || value === '' ? fallback : String(value));

    // Build event details HTML (same as original implementation)
    let html = `
        <div style="display: flex; flex-direction: column; gap: 1rem;">
            <!-- Basic Information -->
            <div style="border-bottom: 1px solid #404040; padding-bottom: 1rem;">
                <h3 style="color: var(--app-text-inverse); font-size: 1rem; margin-bottom: 0.75rem; font-weight: 600;">Basic Information</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; font-size: 0.875rem;">
                    <div>
                        <span style="color: var(--app-text-secondary);">Ticket Number:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${eventText(report.ticketNumber)}</div>
                    </div>
                    <div>
                        <span style="color: var(--app-text-secondary);">Incident Date:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${eventText(report.incidentDate)} ${eventText(report.incidentTime, '')}</div>
                    </div>
                    <div style="grid-column: 1 / -1;">
                        <span style="color: var(--app-text-secondary);">Address:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${eventText(report.address)}</div>
                    </div>
                </div>
            </div>
            
            <!-- Event Details -->
            <div style="border-bottom: 1px solid #404040; padding-bottom: 1rem;">
                <h3 style="color: var(--app-text-inverse); font-size: 1rem; margin-bottom: 0.75rem; font-weight: 600;">Event Details</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; font-size: 0.875rem;">
                    <div>
                        <span style="color: var(--app-text-secondary);">Utility Type:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${eventText(report.utilityType)}</div>
                    </div>
                    <div>
                        <span style="color: var(--app-text-secondary);">Severity:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${eventText(report.severity)}</div>
                    </div>
                    <div>
                        <span style="color: var(--app-text-secondary);">Damage Type:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${eventText(report.damageType)}</div>
                    </div>
                    <div>
                        <span style="color: var(--app-text-secondary);">Location:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">
                            ${report.location ? formatLatLng(report.location.lat, report.location.lng) : '—'}
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Description -->
            ${report.description ? `
            <div style="border-bottom: 1px solid #404040; padding-bottom: 1rem;">
                <h3 style="color: var(--app-text-inverse); font-size: 1rem; margin-bottom: 0.75rem; font-weight: 600;">Description</h3>
                <div style="color: var(--app-text-inverse); font-size: 0.875rem; white-space: pre-wrap;">${eventText(report.description, '')}</div>
            </div>
            ` : ''}
            
            <!-- Personnel -->
            <div style="border-bottom: 1px solid #404040; padding-bottom: 1rem;">
                <h3 style="color: var(--app-text-inverse); font-size: 1rem; margin-bottom: 0.75rem; font-weight: 600;">Personnel</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; font-size: 0.875rem;">
                    <div>
                        <span style="color: var(--app-text-secondary);">Technician Name:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${eventText(report.technicianName)}</div>
                    </div>
                    <div>
                        <span style="color: var(--app-text-secondary);">Technician Phone:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${eventText(report.technicianPhone)}</div>
                    </div>
                    <div>
                        <span style="color: var(--app-text-secondary);">Technician Email:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${eventText(report.technicianEmail)}</div>
                    </div>
                    ${report.supervisor && report.supervisor.notified ? `
                    <div>
                        <span style="color: var(--app-text-secondary);">Supervisor:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">
                            ${eventText(report.supervisor.name)}<br>
                            <span style="font-size: 0.75rem; color: var(--app-text-secondary);">Notified: ${eventText(report.supervisor.timeNotified)}</span>
                        </div>
                    </div>
                    ` : ''}
                </div>
            </div>
            
            <!-- Scene Information -->
            ${(report.sceneSecured !== undefined || report.areaMarked !== undefined || report.workStopped !== undefined || report.equipmentRemoved !== undefined) ? `
            <div style="border-bottom: 1px solid #404040; padding-bottom: 1rem;">
                <h3 style="color: var(--app-text-inverse); font-size: 1rem; margin-bottom: 0.75rem; font-weight: 600;">Scene Information</h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; font-size: 0.875rem;">
                    ${report.sceneSecured !== undefined ? `
                    <div>
                        <span style="color: var(--app-text-secondary);">Scene Secured:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${report.sceneSecured ? 'Yes' : 'No'}</div>
                    </div>
                    ` : ''}
                    ${report.areaMarked !== undefined ? `
                    <div>
                        <span style="color: var(--app-text-secondary);">Area Marked:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${report.areaMarked ? 'Yes' : 'No'}</div>
                    </div>
                    ` : ''}
                    ${report.workStopped !== undefined ? `
                    <div>
                        <span style="color: var(--app-text-secondary);">Work Stopped:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${report.workStopped ? 'Yes' : 'No'}</div>
                    </div>
                    ` : ''}
                    ${report.equipmentRemoved !== undefined ? `
                    <div>
                        <span style="color: var(--app-text-secondary);">Equipment Removed:</span>
                        <div style="color: var(--app-text-inverse); margin-top: 0.25rem;">${report.equipmentRemoved ? 'Yes' : 'No'}</div>
                    </div>
                    ` : ''}
                </div>
            </div>
            ` : ''}
            
            <!-- Additional Information -->
            ${(report.notes || report.followUpActions) ? `
            <div style="border-bottom: 1px solid #404040; padding-bottom: 1rem;">
                <h3 style="color: var(--app-text-inverse); font-size: 1rem; margin-bottom: 0.75rem; font-weight: 600;">Additional Information</h3>
                ${report.notes ? `
                <div style="margin-bottom: 0.75rem;">
                    <span style="color: var(--app-text-secondary); font-size: 0.875rem;">Notes:</span>
                    <div style="color: var(--app-text-inverse); font-size: 0.875rem; margin-top: 0.25rem; white-space: pre-wrap;">${eventText(report.notes, '')}</div>
                </div>
                ` : ''}
                ${report.followUpActions ? `
                <div>
                    <span style="color: var(--app-text-secondary); font-size: 0.875rem;">Follow-up Actions:</span>
                    <div style="color: var(--app-text-inverse); font-size: 0.875rem; margin-top: 0.25rem; white-space: pre-wrap;">${eventText(report.followUpActions, '')}</div>
                </div>
                ` : ''}
            </div>
            ` : ''}
            
            <!-- Actions -->
            <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem;">
                <button type="button" class="button event-details-edit-btn" style="background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse));">
                    Edit
                </button>
                ${report.location ? `
                <button type="button" class="button event-details-zoom-btn" style="background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse));">
                    Zoom to Location
                </button>
                ` : ''}
                <button type="button" class="button event-details-close-btn" style="background: var(--app-bg-muted); color: var(--app-text-primary);">
                    Close
                </button>
            </div>
        </div>
    `;
    
    content.innerHTML = html;
    const editBtn = content.querySelector('.event-details-edit-btn');
    if (editBtn) {
        editBtn.addEventListener('click', function () {
            closeEventDetailsModal();
            openDirtReportModalForEvent(eventId);
        });
    }
    const zoomBtn = content.querySelector('.event-details-zoom-btn');
    if (zoomBtn) {
        zoomBtn.addEventListener('click', function () {
            zoomToEvent(eventId);
            closeEventDetailsModal();
        });
    }
    const closeBtn = content.querySelector('.event-details-close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closeEventDetailsModal);
    }
    modal.style.display = 'flex';
    modal.style.zIndex = '70000'; // Ensure it's above data window
    document.body.style.overflow = 'hidden';
}

// Close event details modal
function closeEventDetailsModal() {
    const modal = document.getElementById('eventDetailsModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
}

let eventLocationClickHandler = null;
let eventLocationTempMarker = null;
let showOnMapEventPinMarker = null;

function createEventMapDivIcon(size) {
    if (window.mapIcons && typeof window.mapIcons.buildEventMapDivIconOptions === 'function') {
        return L.divIcon(window.mapIcons.buildEventMapDivIconOptions(size));
    }
    return L.divIcon({
        className: 'event-marker',
        html:
            '<div style="background-color: var(--app-danger); width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: 14px; font-weight: bold;">⚠</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
    });
}

function clearShowOnMapEventPinMarker() {
    if (!showOnMapEventPinMarker) return;
    try {
        showOnMapEventPinMarker.remove();
    } catch (_) {
        /* ignore */
    }
    showOnMapEventPinMarker = null;
}

function reportedEventStableId(report) {
    if (!report) return '';
    if (report._stableId != null && String(report._stableId) !== '') return String(report._stableId);
    if (report.clientLegacyId != null && String(report.clientLegacyId) !== '') return String(report.clientLegacyId);
    if (report.id != null && String(report.id) !== '') return String(report.id);
    return '';
}

function buildEventMapMarkerPopupHtml(report) {
    const escAttr = typeof window.escapeHtmlAttr === 'function' ? window.escapeHtmlAttr : (s) => String(s ?? '');
    const eventId = escAttr(reportedEventStableId(report));
    const ticket = escapeHtml(report.ticketNumber || '—');
    const date = escapeHtml(report.incidentDate || '—');
    const severity = escapeHtml(report.severity || '—');
    const gpsRow =
        report.location && typeof window.buildMapPopupGpsRow === 'function'
            ? window.buildMapPopupGpsRow(report.location.lat, report.location.lng)
            : '';
    const draftRow =
        report.isDraft === true
            ? '<div class="map-leaflet-popup__meta">Status: <strong>Draft</strong></div>'
            : '';
    return (
        '<div class="map-leaflet-popup">' +
        '<div class="map-leaflet-popup__title">Event Report</div>' +
        '<div class="map-leaflet-popup__meta">Ticket: <strong>' +
        ticket +
        '</strong></div>' +
        '<div class="map-leaflet-popup__meta">Date: <strong>' +
        date +
        '</strong></div>' +
        '<div class="map-leaflet-popup__meta">Severity: <strong>' +
        severity +
        '</strong></div>' +
        draftRow +
        gpsRow +
        '<div class="map-leaflet-popup__actions">' +
        '<button type="button" class="map-leaflet-popup__btn" onclick="openDirtReportModalForEvent(\'' +
        eventId +
        "')\">Open Report</button>" +
        '</div></div>'
    );
}

function wireEventMapMarkerPopup(marker, report) {
    if (!marker || !report) return;
    marker.bindPopup(buildEventMapMarkerPopupHtml(report));
}

function reportedEventServerId(report) {
    let sid = parseInt(String(report.id), 10);
    if (!Number.isFinite(sid) && report.serverId != null) sid = Number(report.serverId);
    return Number.isFinite(sid) ? sid : null;
}

function reportedEventOrgId() {
    if (typeof window.getCurrentOrgId === 'function') {
        const v = window.getCurrentOrgId();
        if (v != null && v !== '') return v;
    }
    const user = window.authModule?.getCurrentUser?.();
    return user?.organizationId ?? null;
}

function reportedEventIsSubmitted(report) {
    return !!(report && report.isDraft !== true);
}

async function promptReportedEventEditPassword(report, reason) {
    if (!reportedEventIsSubmitted(report)) return '';
    if (typeof window.appPasswordPrompt !== 'function') {
        void appAlert('Password confirmation is not available. Please refresh and try again.');
        return null;
    }
    return window.appPasswordPrompt(
        reason || 'Enter your account password to update this submitted report.',
        { title: 'Confirm password', confirmText: 'Continue' }
    );
}

function buildReportedEventPutBody(report, orgId, patch, password) {
    const body = { ...report, organizationId: orgId, ...(patch || {}) };
    if (password) body.password = password;
    return body;
}

async function saveReportedEventLocation(report, lat, lng) {
    report.location = { lat, lng };
    const orgId = reportedEventOrgId();
    const sid = reportedEventServerId(report);
    if (window.authModule?.apiRequest && sid != null && orgId != null) {
        const password = await promptReportedEventEditPassword(
            report,
            'Enter your account password to set the location on this submitted report.'
        );
        if (password == null) {
            throw new Error('Password confirmation cancelled.');
        }
        await window.authModule.apiRequest(`data/reported-events/${sid}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildReportedEventPutBody(report, orgId, { location: { lat, lng } }, password)),
        });
        if (window.reportedEventsStore?.invalidate) {
            window.reportedEventsStore.invalidate();
            await window.reportedEventsStore.ensureLoaded();
        }
        return;
    }
    try {
        const all = JSON.parse(localStorage.getItem('dirtReports') || '[]');
        const key = String(report.id);
        const idx = all.findIndex(
            (r, i) =>
                String(r.id) === key ||
                String(r.clientLegacyId) === key ||
                String(r.id || `event-${i}`) === key
        );
        if (idx >= 0) {
            all[idx] = { ...all[idx], location: { lat, lng } };
            localStorage.setItem('dirtReports', JSON.stringify(all));
        }
    } catch (e) {
        console.error('saveReportedEventLocation:', e);
        throw e;
    }
}

function upsertEventMapMarker(report, latlng) {
    const map = window.map;
    if (!map) return;
    clearShowOnMapEventPinMarker();
    if (report.marker && map.hasLayer(report.marker)) {
        map.removeLayer(report.marker);
    }
    const marker = L.marker(latlng, { icon: createEventMapDivIcon() });
    wireEventMapMarkerPopup(marker, report);
    marker.addTo(map);
    report.marker = marker;
}

function cancelOtherMapModesForEventLocation() {
    if (window.drawingModule?.currentDrawingMode && window.drawingModule.cancelDrawingMode) {
        window.drawingModule.cancelDrawingMode();
    }
    if (window.measureModule?.cancelMeasureMode) {
        window.measureModule.cancelMeasureMode();
    }
    if (window.photosModule?.cancelPhotoLocationTag) {
        window.photosModule.cancelPhotoLocationTag();
    }
    if (window.photosModule?.photoUploadMode && window.photosModule.cancelPhotoUpload) {
        window.photosModule.cancelPhotoUpload();
    }
    if (
        window.documentsModule?.getDocumentLocationMode?.() &&
        window.documentsModule.cancelDocumentLocationDrawing
    ) {
        window.documentsModule.cancelDocumentLocationDrawing();
    }
}

function cancelEventLocationDrawing() {
    const map = window.map;
    window.eventLocationDrawing = false;
    window.eventLocationTargetId = null;
    if (map && eventLocationClickHandler) {
        map.off('click', eventLocationClickHandler);
    }
    eventLocationClickHandler = null;
    if (map) {
        map.getContainer().style.cursor = '';
    }
    if (window.ticketsModule?.syncTicketLayerPointerInteraction) {
        window.ticketsModule.syncTicketLayerPointerInteraction();
    }
    if (map && eventLocationTempMarker && map.hasLayer(eventLocationTempMarker)) {
        map.removeLayer(eventLocationTempMarker);
    }
    eventLocationTempMarker = null;
    const existingConfirm = document.getElementById('eventLocationConfirm');
    if (existingConfirm?.parentNode) {
        existingConfirm.parentNode.removeChild(existingConfirm);
    }
    const wasOpen = window.eventLocationDataWindowWasOpen;
    const view = window.eventLocationDataWindowView || 'events';
    window.eventLocationDataWindowWasOpen = false;
    window.eventLocationDataWindowView = null;
    if (wasOpen && window.openDataWindow) {
        setTimeout(() => window.openDataWindow(view), 100);
    }
}

function startEventLocationDrawing(eventId) {
    const report = findDirtReportByStableId(eventId);
    if (!report) {
        void appAlert('Event not found.');
        return;
    }
    const map = window.map;
    if (!map) {
        void appAlert('Map not available.');
        return;
    }

    cancelEventLocationDrawing();

    const dataWindow = document.getElementById('dataWindow');
    window.eventLocationDataWindowWasOpen = !!(dataWindow && dataWindow.classList.contains('show'));
    window.eventLocationDataWindowView =
        window.eventLocationDataWindowWasOpen && window.dataWindowModule
            ? window.dataWindowModule.currentDataView
            : 'events';
    if (window.eventLocationDataWindowWasOpen && window.closeDataWindow) {
        window.closeDataWindow();
    }

    cancelOtherMapModesForEventLocation();

    window.eventLocationDrawing = true;
    window.eventLocationTargetId = eventId;
    map.getContainer().style.cursor = 'crosshair';
    if (window.ticketsModule?.syncTicketLayerPointerInteraction) {
        window.ticketsModule.syncTicketLayerPointerInteraction();
    }

    eventLocationClickHandler = async function (e) {
        L.DomEvent.stopPropagation(e);
        map.off('click', eventLocationClickHandler);
        eventLocationClickHandler = null;
        map.getContainer().style.cursor = '';
        window.eventLocationDrawing = false;
        window.eventLocationTargetId = null;

        if (eventLocationTempMarker && map.hasLayer(eventLocationTempMarker)) {
            map.removeLayer(eventLocationTempMarker);
        }
        eventLocationTempMarker = null;

        const viewToRestore = window.eventLocationDataWindowView || 'events';
        const reopen = window.eventLocationDataWindowWasOpen;
        window.eventLocationDataWindowWasOpen = false;
        window.eventLocationDataWindowView = null;

        try {
            await saveReportedEventLocation(report, e.latlng.lat, e.latlng.lng);
            upsertEventMapMarker(report, e.latlng);
            if (window.dataTableRendererModule?.renderDataTable) {
                window.dataTableRendererModule.renderDataTable();
            }
            if (reopen && window.openDataWindow) {
                setTimeout(() => window.openDataWindow(viewToRestore), 100);
            }
            void appAlert('Event location saved.');
        } catch (err) {
            console.error('startEventLocationDrawing:', err);
            void appAlert(err.message || 'Failed to save event location.');
            if (reopen && window.openDataWindow) {
                setTimeout(() => window.openDataWindow(viewToRestore), 100);
            }
        }
    };

    map.on('click', eventLocationClickHandler);
    void appAlert('Click on the map to set the event location.');
}

async function removeEventLocation(eventId) {
    const report = findDirtReportByStableId(eventId);
    if (!report) return;

    if (!(await appConfirm('Remove this event location from the map?'))) {
        return;
    }

    report.location = null;
    const orgId = reportedEventOrgId();
    const sid = reportedEventServerId(report);

    try {
        if (window.authModule?.apiRequest && sid != null && orgId != null) {
            const password = await promptReportedEventEditPassword(
                report,
                'Enter your account password to remove the location from this submitted report.'
            );
            if (password == null) {
                return;
            }
            await window.authModule.apiRequest(`data/reported-events/${sid}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildReportedEventPutBody(report, orgId, { location: null }, password)),
            });
            if (window.reportedEventsStore?.invalidate) {
                window.reportedEventsStore.invalidate();
                await window.reportedEventsStore.ensureLoaded();
            }
        } else {
            const all = JSON.parse(localStorage.getItem('dirtReports') || '[]');
            const key = String(report.id);
            const idx = all.findIndex(
                (r, i) =>
                    String(r.id) === key ||
                    String(r.clientLegacyId) === key ||
                    String(r.id || `event-${i}`) === key
            );
            if (idx >= 0) {
                all[idx] = { ...all[idx], location: null };
                localStorage.setItem('dirtReports', JSON.stringify(all));
            }
        }

        if (report.marker && window.map?.hasLayer(report.marker)) {
            window.map.removeLayer(report.marker);
        }
        report.marker = null;

        if (window.dataTableRendererModule?.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    } catch (e) {
        console.error('removeEventLocation:', e);
        void appAlert(e.message || 'Failed to remove event location.');
    }
}

// Zoom to event location
function zoomToEvent(eventId) {
    closeMobilePanelsIfNeeded();

    const report = findDirtReportByStableId(eventId);
    if (!report || !report.location || !window.map) return;

    const lat = Number(report.location.lat);
    const lng = Number(report.location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const map = window.map;
    map.setView([lat, lng], Math.max(map.getZoom(), 15));

    clearShowOnMapEventPinMarker();
    if (report.marker && map.hasLayer(report.marker)) {
        wireEventMapMarkerPopup(report.marker, report);
        return;
    }
    if (report.marker && !map.hasLayer(report.marker)) {
        wireEventMapMarkerPopup(report.marker, report);
        report.marker.addTo(map);
        return;
    }

    showOnMapEventPinMarker = L.marker([lat, lng], { icon: createEventMapDivIcon() });
    wireEventMapMarkerPopup(showOnMapEventPinMarker, report);
    showOnMapEventPinMarker.addTo(map);
}

// Delete event
async function deleteEvent(eventId) {
    if (window.orgDataPermissionsModule && !window.orgDataPermissionsModule.guardDeleteOrgData()) {
        return;
    }
    const windowModule = window.dataWindowModule;
    if (windowModule) {
        windowModule.isDeleting = true;
    }
    
    if (!(await appConfirm('Are you sure you want to delete this event report?'))) {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
        return;
    }
    
    let currentOrgId = null;
    if (window.authModule && window.authModule.isAuthenticated()) {
        currentOrgId = window.authModule.getCurrentUser().organizationId;
    }

    const orgId =
        typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : currentOrgId;

    const existing = findDirtReportByStableId(eventId);
    let serverNumericId = parseInt(String(eventId), 10);
    if (!Number.isFinite(serverNumericId) && existing && existing.serverId != null) {
        serverNumericId = Number(existing.serverId);
    }
    if (!Number.isFinite(serverNumericId) && existing && existing.id != null) {
        serverNumericId = parseInt(String(existing.id), 10);
    }

    try {
        if (Number.isFinite(serverNumericId)) {
            await window.authModule.apiRequest(
                `data/reported-events/${serverNumericId}?organizationId=${encodeURIComponent(String(orgId))}`,
                { method: 'DELETE' }
            );
        } else if (existing) {
            void appAlert('Could not delete this event (missing server id). Try refreshing Data Hub.');
            if (windowModule) windowModule.isDeleting = false;
            return;
        }

        if (existing && existing.marker && window.map) {
            window.map.removeLayer(existing.marker);
        }
        clearShowOnMapEventPinMarker();

        if (window.reportedEventsStore && window.reportedEventsStore.invalidate) {
            window.reportedEventsStore.invalidate();
            await window.reportedEventsStore.ensureLoaded();
        }

        if (window.dataSelectionModule) {
            window.dataSelectionModule.selectedDataIds.delete(eventId);
            window.dataSelectionModule.updateBulkActionsVisibility();
        }

        if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    } catch (e) {
        console.error('deleteEvent:', e);
        void appAlert(e.message || 'Failed to delete event');
    }

    // Reset flag after a short delay
    setTimeout(() => {
        if (windowModule) {
            windowModule.isDeleting = false;
        }
    }, 100);
}
