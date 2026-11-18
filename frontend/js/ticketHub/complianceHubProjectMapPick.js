'use strict';

/** Map pick: add multiple tickets to a project by clicking polygons or drawing an area. */
let complianceHubProjectMapPickJobKey = null;
const complianceHubProjectMapPickSelectedIds = new Set();
const complianceHubProjectMapPickExcludedIds = new Set();
let complianceHubProjectMapPickToolbarEl = null;
let complianceHubProjectMapPickInstructionEl = null;
let complianceHubProjectMapPickPolygonLayer = null;
let complianceHubProjectMapPickPolygonCleanup = null;
let complianceHubProjectMapPickHubWasOpen = false;

function complianceHubProjectMapPickIsActive() {
    return !!complianceHubProjectMapPickJobKey;
}

function complianceHubProjectMapPickEligibleTickets() {
    const pools = [window.ORG_TICKETS, window.HUB_COMBINED_TICKETS, window.HUB_ACTIVE_TICKETS];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < pools.length; i++) {
        const list = pools[i];
        if (!Array.isArray(list)) continue;
        for (let j = 0; j < list.length; j++) {
            const t = list[j];
            if (!t || t.id == null) continue;
            const id = String(t.id);
            if (seen.has(id)) continue;
            seen.add(id);
            if (!t.polygon) continue;
            if (complianceHubProjectMapPickExcludedIds.has(id)) continue;
            out.push(t);
        }
    }
    return out;
}

function ticketOverlapsComplianceHubProjectPickPolygon(ticket, queryLeafletPolygon) {
    if (!queryLeafletPolygon || !ticket || !ticket.polygon) return false;
    const tqm = window.tableQueriesModule;
    if (!tqm || typeof tqm.documentIntersectsPolygon !== 'function' || typeof tqm.isPointInPolygon !== 'function') {
        return true;
    }
    const geo = ticket.polygon;
    try {
        if (geo.type === 'Polygon') {
            if (tqm.documentIntersectsPolygon(geo, queryLeafletPolygon)) return true;
        } else if (geo.type === 'MultiPolygon') {
            for (let i = 0; i < geo.coordinates.length; i++) {
                const part = { type: 'Polygon', coordinates: geo.coordinates[i] };
                if (tqm.documentIntersectsPolygon(part, queryLeafletPolygon)) return true;
            }
        } else {
            return false;
        }
        const gj = L.geoJSON(geo);
        const qRing = queryLeafletPolygon.getLatLngs()[0];
        let inside = false;
        gj.eachLayer(function (lay) {
            if (inside || !(lay instanceof L.Polygon)) return;
            for (let i = 0; i < qRing.length; i++) {
                const p = qRing[i];
                if (lay.getBounds().contains(p) && tqm.isPointInPolygon(p, lay)) {
                    inside = true;
                    break;
                }
            }
        });
        return inside;
    } catch (e) {
        return false;
    }
}

function complianceHubProjectMapPickRefreshPolygonStyles() {
    if (!complianceHubProjectMapPickIsActive()) return;
    if (
        window.ticketsModule &&
        typeof window.ticketsModule.highlightComplianceHubProjectMapPickSelection === 'function'
    ) {
        window.ticketsModule.highlightComplianceHubProjectMapPickSelection(complianceHubProjectMapPickSelectedIds);
    } else if (
        window.ticketsModule &&
        typeof window.ticketsModule.highlightTicketPolygonsForQueryMode === 'function'
    ) {
        window.ticketsModule.highlightTicketPolygonsForQueryMode();
    }
}

function syncComplianceHubProjectMapPickToolbar() {
    const bar = complianceHubProjectMapPickToolbarEl;
    if (!bar) return;
    const n = complianceHubProjectMapPickSelectedIds.size;
    const label = bar.querySelector('[data-compliance-hub-map-pick-count]');
    const addBtn = bar.querySelector('[data-compliance-hub-map-pick-add]');
    if (label) {
        label.textContent = n === 1 ? '1 ticket selected' : `${n} tickets selected`;
    }
    if (addBtn) {
        addBtn.disabled = n === 0;
        addBtn.textContent = n === 0 ? 'Add to project' : n === 1 ? 'Add 1 ticket' : `Add ${n} tickets`;
    }
}

function removeComplianceHubProjectMapPickUi() {
    if (complianceHubProjectMapPickToolbarEl && complianceHubProjectMapPickToolbarEl.parentNode) {
        complianceHubProjectMapPickToolbarEl.parentNode.removeChild(complianceHubProjectMapPickToolbarEl);
    }
    complianceHubProjectMapPickToolbarEl = null;
    if (complianceHubProjectMapPickInstructionEl && complianceHubProjectMapPickInstructionEl.parentNode) {
        complianceHubProjectMapPickInstructionEl.parentNode.removeChild(complianceHubProjectMapPickInstructionEl);
    }
    complianceHubProjectMapPickInstructionEl = null;
    if (complianceHubProjectMapPickPolygonLayer && window.map) {
        try {
            window.map.removeLayer(complianceHubProjectMapPickPolygonLayer);
        } catch (e) {
            /* ignore */
        }
    }
    complianceHubProjectMapPickPolygonLayer = null;
}

function complianceHubProjectMapPickToggleTicket(ticket) {
    if (!ticket || ticket.id == null || !complianceHubProjectMapPickIsActive()) return;
    const id = String(ticket.id);
    if (complianceHubProjectMapPickExcludedIds.has(id)) {
        if (typeof window.appAlert === 'function') {
            void window.appAlert('That ticket is already in this project.');
        }
        return;
    }
    if (!ticket.polygon) {
        if (typeof window.appAlert === 'function') {
            void window.appAlert('This ticket has no map boundary to select.');
        }
        return;
    }
    if (complianceHubProjectMapPickSelectedIds.has(id)) {
        complianceHubProjectMapPickSelectedIds.delete(id);
    } else {
        complianceHubProjectMapPickSelectedIds.add(id);
    }
    complianceHubProjectMapPickRefreshPolygonStyles();
    syncComplianceHubProjectMapPickToolbar();
}

function complianceHubProjectMapPickAddPolygonTickets(leafletPolygon) {
    if (!leafletPolygon) return;
    let added = 0;
    complianceHubProjectMapPickEligibleTickets().forEach((t) => {
        if (!ticketOverlapsComplianceHubProjectPickPolygon(t, leafletPolygon)) return;
        const id = String(t.id);
        if (!complianceHubProjectMapPickSelectedIds.has(id)) {
            complianceHubProjectMapPickSelectedIds.add(id);
            added++;
        }
    });
    complianceHubProjectMapPickRefreshPolygonStyles();
    syncComplianceHubProjectMapPickToolbar();
    if (added === 0 && typeof window.appAlert === 'function') {
        void window.appAlert('No additional tickets in that area.');
    }
}

function cancelComplianceHubProjectMapPickPolygonDraw() {
    if (typeof complianceHubProjectMapPickPolygonCleanup === 'function') {
        try {
            complianceHubProjectMapPickPolygonCleanup();
        } catch (e) {
            /* ignore */
        }
    }
    complianceHubProjectMapPickPolygonCleanup = null;
}

function startComplianceHubProjectMapPickPolygonDraw() {
    const map = window.map;
    if (!map) {
        if (typeof window.appAlert === 'function') window.appAlert('Map is not ready.');
        return;
    }
    if (!complianceHubProjectMapPickIsActive()) return;
    cancelComplianceHubProjectMapPickPolygonDraw();
    if (window.ticketHubModule && typeof window.ticketHubModule.cancelPolygonDrawingIfActive === 'function') {
        window.ticketHubModule.cancelPolygonDrawingIfActive();
    }
    if (window.measureModule && window.measureModule.cancelMeasureMode) {
        window.measureModule.cancelMeasureMode();
    }
    if (window.drawingModule && window.drawingModule.cancelDrawingMode) {
        window.drawingModule.cancelDrawingMode();
    }

    let queryPoints = [];
    const queryLayer = L.layerGroup().addTo(map);
    window.mapQueryPolygonDrawing = true;
    if (typeof window.syncMapToolActionVisibility === 'function') window.syncMapToolActionVisibility();
    map.getContainer().style.cursor = 'crosshair';

    let cancelHandler = null;

    function finishPolygon() {
        if (queryPoints.length < 3) {
            if (typeof window.appAlert === 'function') window.appAlert('A polygon needs at least 3 points.');
            return;
        }
        const latlngs = queryPoints.map((p) => [p.lat, p.lng]);
        const leafletPolygon = L.polygon(latlngs);
        complianceHubProjectMapPickAddPolygonTickets(leafletPolygon);
        if (complianceHubProjectMapPickPolygonLayer && map.hasLayer(complianceHubProjectMapPickPolygonLayer)) {
            try {
                map.removeLayer(complianceHubProjectMapPickPolygonLayer);
            } catch (e) {
                /* ignore */
            }
        }
        complianceHubProjectMapPickPolygonLayer = L.polygon(latlngs, {
            color: '#22c55e',
            weight: 3,
            fillColor: '#22c55e',
            fillOpacity: 0.12,
            dashArray: '6, 4',
        }).addTo(map);
        cleanupDraw();
    }

    function cleanupDraw() {
        map.off('click', queryClickHandler);
        if (cancelHandler) window.removeEventListener('keydown', cancelHandler);
        try {
            map.removeLayer(queryLayer);
        } catch (e) {
            /* ignore */
        }
        map.getContainer().style.cursor = 'crosshair';
        window.mapQueryPolygonDrawing = false;
        if (typeof window.syncMapToolActionVisibility === 'function') window.syncMapToolActionVisibility();
        complianceHubProjectMapPickPolygonCleanup = null;
        complianceHubProjectMapPickRefreshPolygonStyles();
    }

    const queryClickHandler = function (e) {
        L.DomEvent.stopPropagation(e);
        queryPoints.push(e.latlng);
        queryLayer.clearLayers();
        queryPoints.forEach((point, index) => {
            const isLast = index === queryPoints.length - 1;
            const marker = L.marker(point, {
                icon: L.divIcon({
                    className: 'query-marker',
                    html:
                        '<div style="background-color: ' +
                        (isLast ? 'var(--app-success)' : 'var(--app-accent)') +
                        '; width: ' +
                        (isLast ? '20' : '12') +
                        'px; height: ' +
                        (isLast ? '20' : '12') +
                        'px; border-radius: 50%; border: 2px solid var(--app-text-inverse); box-shadow: 0 2px 4px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ' +
                        (isLast ? '12' : '0') +
                        'px; font-weight: bold; cursor: ' +
                        (isLast ? 'pointer' : 'default') +
                        ';">' +
                        (isLast ? '✓' : '') +
                        '</div>',
                    iconSize: [isLast ? 20 : 12, isLast ? 20 : 12],
                    iconAnchor: [isLast ? 10 : 6, isLast ? 10 : 6],
                }),
            });
            if (isLast) {
                marker.on('click', function () {
                    finishPolygon();
                });
            }
            queryLayer.addLayer(marker);
        });
        if (queryPoints.length >= 2) {
            queryLayer.addLayer(
                L.polygon(
                    queryPoints.map((p) => [p.lat, p.lng]),
                    { color: '#22c55e', weight: 3, fill: false, dashArray: '5, 5' }
                )
            );
        }
    };

    cancelHandler = function (e) {
        if (e.key !== 'Escape') return;
        cleanupDraw();
    };

    complianceHubProjectMapPickPolygonCleanup = cleanupDraw;
    map.on('click', queryClickHandler);
    window.addEventListener('keydown', cancelHandler);
}

function ensureComplianceHubProjectMapPickUi() {
    if (complianceHubProjectMapPickToolbarEl) return;
    const instruction = document.createElement('div');
    instruction.id = 'complianceHubProjectMapPickInstruction';
    instruction.className = 'compliance-hub-project-map-pick-instruction';
    instruction.textContent =
        'Click ticket polygons to select them, or draw an area. Press Escape to cancel.';
    document.body.appendChild(instruction);
    complianceHubProjectMapPickInstructionEl = instruction;

    const bar = document.createElement('div');
    bar.id = 'complianceHubProjectMapPickToolbar';
    bar.className = 'compliance-hub-project-map-pick-toolbar';
    bar.innerHTML =
        '<span class="compliance-hub-project-map-pick-count" data-compliance-hub-map-pick-count>0 tickets selected</span>' +
        '<div class="compliance-hub-project-map-pick-actions">' +
        '<button type="button" class="ticket-hub-bulk-btn" data-compliance-hub-map-pick-draw>Draw area</button>' +
        '<button type="button" class="ticket-hub-bulk-btn ticket-hub-bulk-btn-primary" data-compliance-hub-map-pick-add disabled>Add to project</button>' +
        '<button type="button" class="ticket-hub-bulk-btn" data-compliance-hub-map-pick-cancel>Cancel</button>' +
        '</div>';
    document.body.appendChild(bar);
    complianceHubProjectMapPickToolbarEl = bar;

    bar.querySelector('[data-compliance-hub-map-pick-draw]').addEventListener('click', () => {
        startComplianceHubProjectMapPickPolygonDraw();
    });
    bar.querySelector('[data-compliance-hub-map-pick-add]').addEventListener('click', () => {
        void confirmComplianceHubProjectMapPick();
    });
    bar.querySelector('[data-compliance-hub-map-pick-cancel]').addEventListener('click', () => {
        cancelComplianceHubProjectMapPick(true);
    });
}

async function reopenComplianceHubProjectAfterMapPick(jobKey) {
    const key =
        jobKey != null
            ? String(jobKey).trim().toLowerCase()
            : complianceHubProjectMapPickJobKey;
    if (!key) return;
    if (typeof window.openTicketHubToProject === 'function') {
        await window.openTicketHubToProject(key);
    } else if (typeof window.openTicketHubWindow === 'function') {
        await window.openTicketHubWindow({ skipPacPoll: true, skipServerTicketLoad: true });
    }
}

function cancelComplianceHubProjectMapPick(reopenHub) {
    const savedJobKey = complianceHubProjectMapPickJobKey;
    const shouldReopen = reopenHub && complianceHubProjectMapPickHubWasOpen;
    window.complianceHubProjectMapPickMode = false;
    cancelComplianceHubProjectMapPickPolygonDraw();
    removeComplianceHubProjectMapPickUi();
    complianceHubProjectMapPickSelectedIds.clear();
    complianceHubProjectMapPickExcludedIds.clear();
    complianceHubProjectMapPickJobKey = null;
    complianceHubProjectMapPickHubWasOpen = false;
    const map = window.map;
    if (map && map.getContainer()) {
        map.getContainer().style.cursor = '';
    }
    if (window.ticketsModule && typeof window.ticketsModule.restoreTicketMapPolygonStyles === 'function') {
        window.ticketsModule.restoreTicketMapPolygonStyles();
    }
    if (window.ticketsModule && typeof window.ticketsModule.closeOverlappingTicketPicker === 'function') {
        window.ticketsModule.closeOverlappingTicketPicker();
    }
    if (shouldReopen && savedJobKey) {
        void reopenComplianceHubProjectAfterMapPick(savedJobKey);
    }
}

async function confirmComplianceHubProjectMapPick() {
    const jobKey = complianceHubProjectMapPickJobKey;
    const ids = Array.from(complianceHubProjectMapPickSelectedIds);
    if (!jobKey || !ids.length) return;

    const api =
        typeof window.complianceHubApiBase === 'function' ? window.complianceHubApiBase() : null;
    if (!api || !window.authModule || !window.authModule.apiRequest) {
        if (typeof window.appAlert === 'function') void window.appAlert('Could not add tickets.');
        return;
    }

    const addBtn = complianceHubProjectMapPickToolbarEl
        ? complianceHubProjectMapPickToolbarEl.querySelector('[data-compliance-hub-map-pick-add]')
        : null;
    if (addBtn) addBtn.disabled = true;

    let added = 0;
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
        const ticketId = ids[i];
        try {
            await window.authModule.apiRequest(
                `${api.base}/tickets/job-projects/${encodeURIComponent(jobKey)}/tickets${api.q}`,
                {
                    method: 'POST',
                    body: JSON.stringify({ organizationId: api.orgId, ticketId: Number(ticketId) }),
                }
            );
            added++;
        } catch (err) {
            const msg = err && err.message ? String(err.message) : '';
            if (msg.toLowerCase().includes('already')) skipped++;
            else failed++;
        }
    }

    const savedJobKey = jobKey;
    cancelComplianceHubProjectMapPick(false);
    if (typeof window.renderComplianceHubProjectDetail === 'function') {
        await window.renderComplianceHubProjectDetail(savedJobKey);
    }
    if (typeof window.loadComplianceHubProjects === 'function') {
        await window.loadComplianceHubProjects();
    }
    if (added > 0 && typeof window.refreshProjectAssignmentIndex === 'function') {
        void window.refreshProjectAssignmentIndex({ force: true }).then(() => {
            if (typeof window.renderHubTable === 'function') window.renderHubTable();
            if (typeof window.renderTicketList === 'function') window.renderTicketList();
        });
    }
    await reopenComplianceHubProjectAfterMapPick(savedJobKey);

    if (typeof window.appAlert === 'function') {
        if (failed > 0) {
            void window.appAlert(`Added ${added} ticket(s). ${skipped} already in project. ${failed} failed.`);
        } else if (skipped > 0 && added === 0) {
            void window.appAlert('Selected tickets are already in this project.');
        } else if (skipped > 0) {
            void window.appAlert(`Added ${added} ticket(s). ${skipped} were already in the project.`);
        } else if (added > 0) {
            void window.appAlert(added === 1 ? '1 ticket added to the project.' : `${added} tickets added to the project.`);
        }
    }
}

async function startComplianceHubProjectMapPick(jobKey, excludedIds) {
    const key = jobKey != null ? String(jobKey).trim().toLowerCase() : '';
    if (!key) return;
    const map = window.map;
    if (!map) {
        if (typeof window.appAlert === 'function') void window.appAlert('Map is not ready.');
        return;
    }

    cancelComplianceHubProjectMapPick(false);

    complianceHubProjectMapPickJobKey = key;
    complianceHubProjectMapPickSelectedIds.clear();
    complianceHubProjectMapPickExcludedIds.clear();
    (Array.isArray(excludedIds) ? excludedIds : []).forEach((id) => {
        if (id != null && String(id).trim() !== '') complianceHubProjectMapPickExcludedIds.add(String(id));
    });

    const hubWin = document.getElementById('ticketHubWindow');
    complianceHubProjectMapPickHubWasOpen = !!(hubWin && hubWin.classList.contains('show'));
    if (typeof window.closeTicketHubProjectDetailModal === 'function') {
        window.closeTicketHubProjectDetailModal();
    }
    if (typeof window.closeTicketHubWindow === 'function' && complianceHubProjectMapPickHubWasOpen) {
        window.closeTicketHubWindow();
    }
    if (typeof window.closeTicketPopup === 'function') {
        window.closeTicketPopup();
    }

    window.complianceHubProjectMapPickMode = true;
    ensureComplianceHubProjectMapPickUi();
    syncComplianceHubProjectMapPickToolbar();
    map.getContainer().style.cursor = 'crosshair';
    if (window.ticketsModule && typeof window.ticketsModule.highlightTicketPolygonsForQueryMode === 'function') {
        window.ticketsModule.highlightTicketPolygonsForQueryMode();
    }
    complianceHubProjectMapPickRefreshPolygonStyles();

    const onEscape = function (e) {
        if (e.key !== 'Escape' || !window.complianceHubProjectMapPickMode) return;
        if (window.mapQueryPolygonDrawing) return;
        document.removeEventListener('keydown', onEscape);
        cancelComplianceHubProjectMapPick(true);
    };
    document.addEventListener('keydown', onEscape);
}

window.complianceHubProjectMapPickToggleTicket = complianceHubProjectMapPickToggleTicket;
window.complianceHubProjectMapPickGetSelectedIds = function complianceHubProjectMapPickGetSelectedIds() {
    return complianceHubProjectMapPickSelectedIds;
};
window.startComplianceHubProjectMapPick = startComplianceHubProjectMapPick;
window.cancelComplianceHubProjectMapPick = cancelComplianceHubProjectMapPick;
