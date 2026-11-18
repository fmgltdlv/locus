    'use strict';

    /** Matches ticket hub fullscreen breakpoint (styles.css / openTicketHubWindow). */
    function isTicketHubMobile() {
        return typeof window !== 'undefined' && window.innerWidth <= 768;
    }

    /** Narrow desktop / tablet: compact map status chip labels (≤1180). */
    function isTicketHubCompactStats() {
        return typeof window !== 'undefined' && window.innerWidth <= 1180;
    }

    /**
     * Narrow viewport layout (phone + narrow desktop ≤1180): compact chips / split.
     * Table column choices are desktop-only (hidden on phone). Use isTicketHubMobile() for phone UI.
     */
    function isTicketHubNarrowTable() {
        return typeof window !== 'undefined' && window.innerWidth <= 1180;
    }

    function hubReportedEventCountForTicket(ticket) {
        if (!ticket) return 0;
        try {
            let reports = [];
            if (window.reportedEventsStore && window.reportedEventsStore.getReportsForCurrentOrg) {
                reports = window.reportedEventsStore.getReportsForCurrentOrg();
            }
            if (!reports.length) {
                reports = JSON.parse(localStorage.getItem('dirtReports') || '[]');
            }
            return reports.filter((r) => reportMatchesTicket(r, ticket)).length;
        } catch (_err) {
            return 0;
        }
    }

    function buildTicketHubReportedEventsSectionHtml(ticket, opts) {
        if (window.CORE_PRODUCT === true) return '';
        const eventCount = hubReportedEventCountForTicket(ticket);
        const forPopup = opts && opts.forPopup;
        const btnClass = forPopup
            ? 'ticket-popup-events-btn ticket-hub-action-btn ticket-hub-action-primary'
            : 'ticket-hub-action-btn ticket-hub-action-primary';
        const btnAttrs = forPopup
            ? ''
            : ' data-hub-action="events" title="Open Reported Events filtered to this ticket"';
        return `<div class="ticket-hub-reported-events-block">
            <div class="ticket-hub-reported-events-row">
                <div class="ticket-hub-reported-events-summary">
                    <div class="ticket-hub-reported-events-label">Reported Events</div>
                    <div class="ticket-hub-reported-events-count">${eventCount}</div>
                </div>
                <button type="button" class="${btnClass}"${btnAttrs}${forPopup ? ' title="Open Reported Events filtered to this ticket"' : ''}>View Events</button>
            </div>
        </div>`;
    }

    function wrapHubOperatorResponsesForTabs(bodyHtml, checkPosrBtn) {
        return `<div class="ticket-detail-tab-panel-inner ticket-hub-operator-tab">
            <div class="ticket-detail-tab-toolbar">${checkPosrBtn}</div>
            ${bodyHtml}
        </div>`;
    }

    function hubSelectAllCheckboxHtml() {
        if (
            window.authModule &&
            typeof window.authModule.isTechInCurrentOrg === 'function' &&
            window.authModule.isTechInCurrentOrg()
        ) {
            return '';
        }
        if (typeof window.appCheckboxHtml === 'function') {
            return window.appCheckboxHtml('aria-label="Select all visible tickets"', {
                wrapperClass: 'app-checkbox--table',
                inputClass: 'ticket-hub-bulk-select-all',
            });
        }
        return '<input type="checkbox" class="ticket-hub-bulk-select-all" aria-label="Select all visible tickets" />';
    }

    function hubTableHeadCell(label, colKey, opts) {
        opts = opts || {};
        const title = opts.title ? ` title="${hubEscapeHtml(opts.title)}"` : '';
        const thClass = opts.thClass ? ` class="${opts.thClass}"` : '';
        const handle =
            colKey && opts.handle !== false && opts.resizable !== false
                ? `<span class="ticket-hub-col-resize-handle" data-hub-col-key="${colKey}" role="separator" aria-orientation="vertical" aria-label="Resize ${hubEscapeHtml(label)} column"></span>`
                : '';
        return (
            `<th scope="col"${title}${thClass} data-hub-col-key="${colKey || ''}">` +
            `<span class="ticket-hub-th-label">${label}</span>${handle}</th>`
        );
    }

    function hubBulkColumnEnabled() {
        return false;
    }

    function getHubTableHeadDesktopHtml() {
        if (window.ticketHubColumnRegistry && typeof window.ticketHubColumnRegistry.renderHeadHtml === 'function') {
            return window.ticketHubColumnRegistry.renderHeadHtml();
        }
        const bulk =
            hubBulkColumnEnabled()
                ? '<th class="ticket-hub-th-bulk" scope="col" title="Select rows for bulk actions" data-hub-col-key="bulk">' +
                  hubSelectAllCheckboxHtml() +
                  '</th>'
                : '';
        return (
            bulk + hubTableHeadCell('Ticket', 'ticket', { handle: false })
        );
    }

    function getHubTableHeadMobileHtml() {
        if (window.ticketHubColumnRegistry && typeof window.ticketHubColumnRegistry.renderHeadHtml === 'function') {
            return window.ticketHubColumnRegistry.renderHeadHtml();
        }
        const bulk =
            hubBulkColumnEnabled()
                ? '<th class="ticket-hub-th-bulk" scope="col" title="Select rows for bulk actions" data-hub-col-key="bulk">' +
                  hubSelectAllCheckboxHtml() +
                  '</th>'
                : '';
        return bulk + hubTableHeadCell('Ticket #', 'ticket', { handle: false });
    }

    function idsMatch(a, b) {
        if (typeof window.ticketIdEquals === 'function') return window.ticketIdEquals(a, b);
        if (a === null || a === undefined || b === null || b === undefined) return false;
        return String(a) === String(b);
    }

    function getAssignedUsers(ticket) {
        if (!ticket) return [];
        if (typeof window.getProjectAssigneesForTicket === 'function') {
            return window.getProjectAssigneesForTicket(ticket);
        }
        if (typeof window.ticketsModule?.getTicketAssignedUsers === 'function') {
            return window.ticketsModule.getTicketAssignedUsers(ticket);
        }
        return [];
    }

    function isAssignedToUser(ticket, userId) {
        const parsedUserId = parseInt(userId, 10);
        if (Number.isNaN(parsedUserId)) return false;
        if (typeof window.ticketIsAssignedToUserViaProject === 'function') {
            return window.ticketIsAssignedToUserViaProject(ticket, parsedUserId);
        }
        return getAssignedUsers(ticket).some(a => a.userId === parsedUserId);
    }

    function hasAnyAssignee(ticket) {
        if (typeof window.ticketHasAnyProjectAssignee === 'function') {
            return window.ticketHasAnyProjectAssignee(ticket);
        }
        return getAssignedUsers(ticket).length > 0;
    }

    function findTicketForHub(ticketId) {
        const feedDetail = window.__FEED_HUB_DETAIL_TICKET;
        if (feedDetail && idsMatch(feedDetail.id, ticketId)) return feedDetail;
        const fromRecentlyOpened = (window.HUB_RECENTLY_OPENED_TICKETS || []).find((t) =>
            idsMatch(t.id, ticketId)
        );
        if (fromRecentlyOpened) return fromRecentlyOpened;
        const fromHubCombined = (window.HUB_COMBINED_TICKETS || []).find((t) => idsMatch(t.id, ticketId));
        if (fromHubCombined) return fromHubCombined;
        const fromHubActive = (window.HUB_ACTIVE_TICKETS || []).find((t) => idsMatch(t.id, ticketId));
        if (fromHubActive) return fromHubActive;
        const fromHubExpired = (window.HUB_EXPIRED_TICKETS || []).find((t) => idsMatch(t.id, ticketId));
        if (fromHubExpired) return fromHubExpired;
        return (window.ORG_TICKETS || []).find((t) => idsMatch(t.id, ticketId));
    }

    function formatHubDate(dateString) {
        if (!dateString) return window.TICKET_HUB_TEXT.EM_DASH;
        return window.formatRecordedDateTime(dateString, window.TICKET_HUB_TEXT.EM_DASH, String(dateString));
    }

    function hubFirstNonEmpty(...vals) {
        for (const v of vals) {
            if (v != null && String(v).trim() !== '') return v;
        }
        return null;
    }

    /**
     * Resolved display value using `ticketHubDisplayMap.js` (ordered storage/raw fallbacks), then optional legacy fallbacks.
     * @param {object} ticket
     * @param {string} fieldId - key in HUB_FIELD_SOURCES / HUB_FIELD_PICKERS
     * @param {...*} [fallbacks]
     */
    function hubMappedField(ticket, fieldId, ...fallbacks) {
        let v = null;
        if (window.ticketHubDisplayMap && typeof window.ticketHubDisplayMap.pickTicketField === 'function') {
            v = window.ticketHubDisplayMap.pickTicketField(ticket, fieldId);
        }
        return hubFirstNonEmpty(v, ...fallbacks);
    }

    function hubTicketTypeDisplayRaw(ticket) {
        const dm = window.ticketHubDisplayMap;
        if (dm && typeof dm.formatTicketTypeWithUsanStatus === 'function') {
            return dm.formatTicketTypeWithUsanStatus(ticket);
        }
        return hubMappedField(ticket, 'providerTicketType');
    }

    /**
     * Display a ticket field value; use N/A when missing (per product request).
     * @param {*} val
     * @param {{ date?: boolean }} [opts]
     */
    function hubFieldDisplayValue(val, opts) {
        const date = opts && opts.date;
        if (val == null || val === '') return 'N/A';
        if (typeof val === 'boolean') return val ? 'Yes' : 'No';
        if (typeof val === 'number' && Number.isFinite(val)) return String(val);
        const t = String(val).trim();
        if (t === '') return 'N/A';
        if (date) {
            const fd = formatHubDate(t);
            return !fd || fd === window.TICKET_HUB_TEXT.EM_DASH ? 'N/A' : fd;
        }
        return t;
    }

    function hubFieldBoolish(val) {
        if (val == null || val === '') return 'N/A';
        if (typeof val === 'boolean') return val ? 'Yes' : 'No';
        const s = String(val).trim().toLowerCase();
        if (s === 'yes' || s === 'y') return 'Yes';
        if (s === 'no' || s === 'n') return 'No';
        if (s === '') return 'N/A';
        return String(val);
    }

    function normalizeHubResponseCount(value) {
        if (value == null || String(value).trim() === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? Math.max(0, n) : null;
    }

    function getHubTicketResponseProgress(ticket) {
        if (
            window.ticketsModule &&
            typeof window.ticketsModule.getTicketResponseProgress === 'function'
        ) {
            return window.ticketsModule.getTicketResponseProgress(ticket);
        }
        const operatorRows = Array.isArray(ticket && ticket.operatorResponses) ? ticket.operatorResponses.length : 0;
        const outstandingRows = Array.isArray(ticket && ticket.outstandingOperators) ? ticket.outstandingOperators.length : 0;
        const required = normalizeHubResponseCount(ticket && ticket.ngenRequiredResponseCount);
        const received = normalizeHubResponseCount(ticket && ticket.ngenReceivedResponseCount);
        if (required != null || received != null) {
            const displayReceived = received != null ? received : 0;
            const outstanding = required != null && received != null ? Math.max(0, required - received) : null;
            return {
                source: 'ngen',
                required,
                received: displayReceived,
                outstanding,
                complete: required != null && received != null ? displayReceived >= required : null,
                label: required != null ? `${displayReceived}/${required}` : String(displayReceived),
            };
        }
        return {
            source: 'operatorRows',
            required: operatorRows,
            received: operatorRows,
            outstanding: outstandingRows,
            complete: outstandingRows === 0,
            label: String(operatorRows),
        };
    }

    function formatHubResponseProgressDetail(ticket) {
        const progress = getHubTicketResponseProgress(ticket);
        if (progress.source !== 'ngen') {
            return `${progress.received || 0} row${progress.received === 1 ? '' : 's'}`;
        }
        if (progress.required != null) {
            const outstanding = progress.outstanding != null ? progress.outstanding : 0;
            return `${progress.label} received${outstanding > 0 ? ` (${outstanding} outstanding)` : ''}`;
        }
        return `${progress.received || 0} received`;
    }

    function hubPolygonPresent(ticket) {
        const p = ticket && ticket.polygon;
        return p && p.type === 'Polygon' && Array.isArray(p.coordinates) ? 'Yes' : 'N/A';
    }

    /**
     * Same photo requirement summary as the map ticket popup (counts, cutoff note, override controls).
     * Buttons use `data-hub-action` for delegation in `bindHubDetailPanelActions`.
     * @param {object} ticket
     */
    function buildTicketHubPhotoRequirementSectionHtml(ticket) {
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
        const photoTotal = photoWindowStats.visibleInWindow;
        const photoOlder = photoWindowStats.hiddenByWindow;

        if (ticket && ticket.shared) {
            const photoOlderLineShared =
                photoOlder > 0
                    ? `<div style="font-size: 0.7rem; color: var(--app-text-secondary); margin-top: 0.25rem;">${photoOlder} older photo${photoOlder === 1 ? '' : 's'} in area (outside ${hubEscapeHtml(photoWindowStats.windowLabel)})</div>`
                    : '';
            const viewBtnShared = `<button type="button" data-hub-action="hub-photo-view" style="padding: 0.5rem 1rem; background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse)); border: none; border-radius: 0.25rem; cursor: pointer; font-size: 0.75rem; font-weight: 500;">View photos (${photoTotal} in area)</button>`;
            return `
            <div class="ticket-hub-photo-requirement ticket-photos-inner ticket-hub-photo-info-only" style="margin-bottom: 0; padding: 0.75rem; background: transparent !important; border: 1px solid var(--app-bg-muted); border-radius: 0.375rem;">
                <div class="ticket-photos-row">
                    <div class="ticket-photos-thumb-icon" aria-hidden="true">${window.TICKET_HUB_TEXT.CAMERA}</div>
                    <div class="ticket-photos-content">
                        <div style="font-size: 0.875rem; color: var(--app-text-secondary); margin-bottom: 0.25rem;">Photos in ticket area</div>
                        <div style="font-size: 1.25rem; font-weight: 600; color: var(--app-text-inverse);">${photoTotal} in area</div>
                        ${photoOlderLineShared}
                        <div style="font-size: 0.75rem; color: var(--app-text-secondary); margin-top: 0.25rem;">Photo requirements are managed by the ticket owner organization.</div>
                    </div>
                    <div class="ticket-photos-actions">${viewBtnShared}</div>
                </div>
            </div>`;
        }

        const photoScopeLabel =
            window.ticketImporterModule && typeof window.ticketImporterModule.getPhotoRequirementScopeLabel === 'function'
                ? window.ticketImporterModule.getPhotoRequirementScopeLabel(ticket)
                : 'this revision';
        const mod = window.workflowAckComplianceModule;
        const photoDisplay =
            mod && typeof mod.getPhotoComplianceDisplayState === 'function'
                ? mod.getPhotoComplianceDisplayState(ticket, photoRegCount, photoScopeLabel)
                : {
                      status: photoRegCount >= 2 ? 'READY' : 'ACTION_REQUIRED',
                      countLabel: `${photoRegCount} / 2`,
                      hint:
                          photoRegCount >= 2
                              ? 'Requirement met for this revision'
                              : 'Review Required: At least 2 photos for this revision',
                      met: photoRegCount >= 2,
                  };
        const photoStatus = photoDisplay.status;
        const photoScopeInArea = photoScopeLabel === 'in area';

        const photoOlderLine =
            photoOlder > 0
                ? `<div style="font-size: 0.7rem; color: var(--app-text-secondary); margin-top: 0.25rem;">${photoOlder} older photo${photoOlder === 1 ? '' : 's'} in area (outside ${hubEscapeHtml(photoWindowStats.windowLabel)})</div>`
                : '';

        const photoInnerClass =
            photoStatus === 'ACTION_REQUIRED'
                ? 'ticket-hub-photo-requirement ticket-photos-inner ticket-photos-inner--action-required'
                : 'ticket-hub-photo-requirement ticket-photos-inner';
        const statusHint =
            photoStatus === 'ACTION_REQUIRED'
                ? `<div class="ticket-photo-revision-hint ticket-photo-revision-hint--action-required">${hubEscapeHtml(photoDisplay.hint)}</div>`
                : `<div class="ticket-photo-revision-hint ticket-photo-revision-hint--met">${hubEscapeHtml(photoDisplay.hint)}</div>`;

        const viewBtn = `<button type="button" data-hub-action="hub-photo-view" style="padding: 0.5rem 1rem; background: var(--app-accent); color: var(--app-button-primary-text, var(--app-text-inverse)); border: none; border-radius: 0.25rem; cursor: pointer; font-size: 0.75rem; font-weight: 500; transition: background-color 0.2s;">View photos (${photoTotal} in area)</button>`;

        return `
            <div class="${photoInnerClass}" style="margin-bottom: 0; padding: 0.75rem; background: transparent !important; border-radius: 0.375rem;">
                <div class="ticket-photos-row">
                    <div class="ticket-photos-thumb-icon" aria-hidden="true">${window.TICKET_HUB_TEXT.CAMERA}</div>
                    <div class="ticket-photos-content">
                        <div style="font-size: 0.875rem; color: var(--app-text-secondary); margin-bottom: 0.25rem;">Photos in Ticket Area</div>
                        <div style="font-size: 1.25rem; font-weight: 600; color: var(--app-text-inverse);">
                            ${hubEscapeHtml(photoDisplay.countLabel)} (${hubEscapeHtml(photoScopeLabel)}) ${photoDisplay.met ? window.TICKET_HUB_TEXT.CHECK : window.TICKET_HUB_TEXT.CROSS}
                        </div>
                        ${photoOlderLine}
                        ${statusHint}
                    </div>
                    <div class="ticket-photos-actions">
                        ${viewBtn}
                    </div>
                </div>
            </div>`;
    }

    /**
     * Full mirror of ticket + parsed confirmation metadata; N/A when not available.
     * @param {object} ticket
     * @param {string} [_assigneeBlock] - unused (ticket-level assignees removed)
     * @param {{ omitPhotos?: boolean, projectsBlock?: string }} [opts]
     */
    function buildTicketHubFullDetailGridHtml(ticket, _assigneeBlock, opts) {
        const parts = [];
        let firstSec = true;
        function sec(title) {
            const flush = firstSec ? ' ticket-hub-detail-section-h--flush' : '';
            firstSec = false;
            parts.push(
                `<div class="ticket-hub-kv ticket-hub-kv-full ticket-hub-detail-section-h${flush}"><span class="ticket-hub-k">${hubEscapeHtml(title)}</span></div>`
            );
        }
        function row(label, displayText) {
            parts.push(
                `<div class="ticket-hub-kv"><span class="ticket-hub-k">${hubEscapeHtml(label)}</span><span class="ticket-hub-v">${hubEscapeHtml(displayText)}</span></div>`
            );
        }
        function rowHtml(label, valueHtml) {
            parts.push(
                `<div class="ticket-hub-kv"><span class="ticket-hub-k">${hubEscapeHtml(label)}</span><div class="ticket-hub-v">${valueHtml}</div></div>`
            );
        }
        /** Section wrapped in <details>; omit `open` so it starts collapsed. */
        function secCollapsible(title, fill) {
            parts.push(
                `<details class="ticket-hub-detail-section-details"><summary class="ticket-hub-detail-section-summary">${hubEscapeHtml(title)}</summary><div class="ticket-hub-detail-section-body">`
            );
            fill();
            parts.push('</div></details>');
        }

        const partsTitle = parseTicketNumberPartsClient(ticket);
        const ticketNumFull =
            (partsTitle.displayFull && String(partsTitle.displayFull).trim()) ||
            String(ticket.ticketNumber || '').trim() ||
            '';
        const revLabel = revisionLabelForTicket(ticket);
        const revStr = revLabel != null && String(revLabel).trim() !== '' ? String(revLabel).trim() : '';

        const organizationDetailText =
            typeof window.getTicketOrganizationDisplayName === 'function'
                ? window.getTicketOrganizationDisplayName(ticket)
                : ticket.shared
                  ? ticket.sharedSourceLabel || 'Partner organization'
                  : '';

        const ticketScopeRaw = hubMappedField(ticket, 'ticketScope');

        const ticketExpirationDisplay =
            window.ticketImporterModule && typeof window.ticketImporterModule.getTicketExpirationDateForStatus === 'function'
                ? window.ticketImporterModule.getTicketExpirationDateForStatus(ticket)
                : hubMappedField(ticket, 'ticketExpirationDate', ticket.ticketExpirationDate, ticket.endTime);

        const responsesDisplay = formatHubResponseProgressDetail(ticket);

        if (
            typeof window.isPosrLaneTicket === 'function' &&
            window.isPosrLaneTicket(ticket)
        ) {
            sec('Ticket');
            row('Ticket #', hubFieldDisplayValue(ticketNumFull));
            row('Revision', revStr ? revStr : 'N/A');
            row('Organization', organizationDetailText ? organizationDetailText : 'N/A');
            const blurb =
                typeof window.buildPosrPortalDetailsBlurbHtml === 'function'
                    ? window.buildPosrPortalDetailsBlurbHtml({ forHub: true })
                    : '';
            parts.push(
                `<div class="ticket-hub-kv ticket-hub-kv-full"><div class="ticket-hub-v">${blurb}</div></div>`
            );
            const omitPhotosPortal = opts && opts.omitPhotos;
            if (!omitPhotosPortal) {
                sec('Photos');
                parts.push(
                    `<div class="ticket-hub-kv ticket-hub-kv-full"><div class="ticket-hub-v">${buildTicketHubPhotoRequirementSectionHtml(ticket)}</div></div>`
                );
            }
            return parts.join('');
        }

        sec('Ticket');
        row('Ticket #', hubFieldDisplayValue(ticketNumFull));
        row('Revision', revStr ? revStr : 'N/A');
        row(
            'Submitted (this rev)',
            hubFieldDisplayValue(hubMappedField(ticket, 'providerLodgedOn'), { date: true })
        );
        row('Previous ticket #', hubFieldDisplayValue(hubMappedField(ticket, 'providerPreviousRequestNumber', ticket.previousTicketNumber)));
        row('Job start', hubFieldDisplayValue(hubMappedField(ticket, 'startTime', ticket.startTime), { date: true }));
        row('Legal start', hubFieldDisplayValue(hubMappedField(ticket, 'legalStartDate', ticket.legalStartDate), { date: true }));
        row('Ticket expiration', hubFieldDisplayValue(ticketExpirationDisplay, { date: true }));
        row('Organization', organizationDetailText ? organizationDetailText : 'N/A');
        const projectsBlock = opts && opts.projectsBlock;
        if (projectsBlock) {
            rowHtml('Projects', projectsBlock);
        }

        const omitPhotos = opts && opts.omitPhotos;
        if (!omitPhotos) {
            sec('Photos');
            parts.push(
                `<div class="ticket-hub-kv ticket-hub-kv-full"><div class="ticket-hub-v">${buildTicketHubPhotoRequirementSectionHtml(ticket)}</div></div>`
            );
        }

        secCollapsible('Location', () => {
            row(
                'Full address',
                hubFieldDisplayValue(
                    hubMappedField(ticket, 'digSiteAddress', ticket.fullAddress, ticket.address, ticket.locationSummary)
                )
            );
            row('Cross street', hubFieldDisplayValue(hubMappedField(ticket, 'nearbyCrossStreet', ticket.nearbyCrossStreet)));
        });

        secCollapsible('Work & project', () => {
            row('Ticket type', hubFieldDisplayValue(hubTicketTypeDisplayRaw(ticket)));
            row('Type of work', hubFieldDisplayValue(hubMappedField(ticket, 'categoryOfWork')));
            row('Work activity', hubFieldDisplayValue(hubMappedField(ticket, 'workActivity', ticket.workActivity)));
            row('Scope of work', hubFieldDisplayValue(ticketScopeRaw));
            row('Work description', hubFieldDisplayValue(hubMappedField(ticket, 'workDescription', ticket.workDescription)));
            row('Excavation method', hubFieldDisplayValue(hubMappedField(ticket, 'excavationMethod', ticket.excavationMethod)));
            row('Planned depth', hubFieldDisplayValue(hubMappedField(ticket, 'providerExcavationDepth', ticket.providerExcavationDepth)));
            row('Project owner classification', hubFieldDisplayValue(hubMappedField(ticket, 'providerWorkingOnBehalf', ticket.providerWorkingOnBehalf)));
            row('Project owner', hubFieldDisplayValue(hubMappedField(ticket, 'providerWorkingOnBehalfOfAuth', ticket.projectOwner, ticket.providerWorkingOnBehalfOfAuth)));
            row('Horizontal / directional boring', hubFieldBoolish(hubMappedField(ticket, 'boring', ticket.boring)));
            row('Explosives / blasting', hubFieldBoolish(hubMappedField(ticket, 'explosives', ticket.explosives)));
            row('Priority', hubFieldDisplayValue(hubMappedField(ticket, 'providerPriority', ticket.providerPriority)));
            row('Job name', hubFieldDisplayValue(hubMappedField(ticket, 'jobName', ticket.jobName)));
            row('Created by', hubFieldDisplayValue(hubMappedField(ticket, 'createdBy', ticket.createdBy)));
        });

        sec('Operators');
        row('Utilities / responses', responsesDisplay);
        const stationCodesDisplay = (() => {
            const fromTicket = ticket.stationCodes;
            if (Array.isArray(fromTicket) && fromTicket.length) return fromTicket.join(', ');
            const fromResponses = ticket.operatorResponses;
            if (Array.isArray(fromResponses) && fromResponses.length) {
                const codes = [...new Set(fromResponses.map((r) => r.stationCode || r.operatorCode).filter(Boolean))];
                if (codes.length) return codes.join(', ');
            }
            return 'N/A';
        })();
        row('Station codes', stationCodesDisplay);

        return parts.join('');
    }

    function reportMatchesTicket(r, ticket) {
        if (!ticket) return false;
        const sameTn =
            r.ticketNumber != null &&
            ticket.ticketNumber != null &&
            String(r.ticketNumber) === String(ticket.ticketNumber);
        const sameId =
            r.ticketId != null && ticket.id != null && String(r.ticketId) === String(ticket.id);
        return sameTn || sameId;
    }

    function closeHubOperatorResponseDetailModal() {
        const el = document.getElementById('ticketHubOperatorResponseDetailModal');
        if (el) el.remove();
    }

    function closeHubResponseCodeDetailModal() {
        const el = document.getElementById('ticketHubResponseCodeDetailModal');
        if (el) el.remove();
    }

    /** Same row list as hub/popup response tables (includes stationDetails fallback). */
    function hubOperatorResponseRowsForIndex(ticket) {
        if (
            window.ticketsModule &&
            typeof window.ticketsModule.ticketOperatorResponseRowsForDisplay === 'function'
        ) {
            return window.ticketsModule.ticketOperatorResponseRowsForDisplay(ticket);
        }
        return ticket && Array.isArray(ticket.operatorResponses) ? ticket.operatorResponses : [];
    }

    /** Backdrop dismiss: close op/response detail only; do not bubble to close Ticket Hub. */
    function bindHubOpDetailOverlayDismiss(wrap, closeFn) {
        wrap.addEventListener('click', (e) => {
            e.stopPropagation();
            hubSuppressOutsideCloseUntil = Date.now() + 500;
            closeFn();
        });
        const panelEl = wrap.querySelector('.ticket-hub-op-detail-panel');
        if (panelEl) panelEl.addEventListener('click', (e) => e.stopPropagation());
    }

    /** Response code description: catalog, then codeDescription, then comment (aligns with map ticket popup). */
    function getHubOperatorResponseCodeDescriptionDisplay(response) {
        if (typeof window.getOperatorResponseCodeDescriptionDisplay === 'function') {
            return window.getOperatorResponseCodeDescriptionDisplay(response);
        }
        if (!response) return window.TICKET_HUB_TEXT.EM_DASH;
        const cd =
            response.codeDescription != null && String(response.codeDescription).trim() !== ''
                ? String(response.codeDescription).trim()
                : null;
        const cm =
            response.comment != null && String(response.comment).trim() !== ''
                ? String(response.comment).trim()
                : null;
        if (cd) return cd;
        if (cm) return cm;
        return window.TICKET_HUB_TEXT.EM_DASH;
    }

    function openHubResponseCodeDetailModal(ticket, index) {
        const responses = hubOperatorResponseRowsForIndex(ticket);
        const response = responses[index];
        if (!response) return;
        closeHubResponseCodeDetailModal();
        closeHubOperatorResponseDetailModal();
        closeOperatorResponseStatusModal();
        hubSuppressOutsideCloseUntil = Date.now() + 300;
        const respondedAt = response.respondedAt ? formatHubDate(response.respondedAt) : window.TICKET_HUB_TEXT.EM_DASH;
        const codeLabel =
            response.statusCode != null && String(response.statusCode).trim() !== ''
                ? String(response.statusCode).trim()
                : window.TICKET_HUB_TEXT.EM_DASH;
        const desc = getHubOperatorResponseCodeDescriptionDisplay(response);
        const descDd =
            desc !== window.TICKET_HUB_TEXT.EM_DASH
                ? hubEscapeHtml(desc)
                : '<span class="ticket-hub-muted">No description available.</span>';
        const commentsHtml = buildHubOperatorResponseCommentsHtml(ticket, response);
        const wrap = document.createElement('div');
        wrap.id = 'ticketHubResponseCodeDetailModal';
        wrap.className = 'ticket-hub-op-detail-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', 'Response code details');
        wrap.innerHTML = `
            <div class="ticket-hub-op-detail-panel">
                <div class="ticket-hub-op-detail-header">
                    <h4 class="ticket-hub-op-detail-title">Response code</h4>
                    <button type="button" class="ticket-hub-op-detail-close" aria-label="Close">&times;</button>
                </div>
                <div class="ticket-hub-op-detail-body">
                    <dl class="ticket-history-detail-dl ticket-hub-op-detail-dl">
                        <dt>Response Code</dt><dd>${hubEscapeHtml(codeLabel)}</dd>
                        <dt>Response Date</dt><dd>${hubEscapeHtml(respondedAt)}</dd>
                        <dt>Code Description</dt><dd>${descDd}</dd>
                        <dt>Comments</dt><dd data-hub-op-comments-dd>${commentsHtml}</dd>
                    </dl>
                </div>
            </div>`;
        bindHubOpDetailOverlayDismiss(wrap, closeHubResponseCodeDetailModal);
        wrap.querySelector('.ticket-hub-op-detail-close').addEventListener('click', (e) => {
            e.stopPropagation();
            hubSuppressOutsideCloseUntil = Date.now() + 500;
            closeHubResponseCodeDetailModal();
        });
        document.body.appendChild(wrap);

        if (typeof window.ensureNgenProviderResponseHistoryForOperator === 'function') {
            const commentsDd = wrap.querySelector('[data-hub-op-comments-dd]');
            if (commentsDd && commentsHtml === window.TICKET_HUB_TEXT.EM_DASH) {
                commentsDd.innerHTML =
                    '<span class="ticket-responses-comments-loading" aria-busy="true">Loading comments…</span>';
            }
            void window.ensureNgenProviderResponseHistoryForOperator(ticket, response).then((updated) => {
                if (!document.getElementById('ticketHubResponseCodeDetailModal')) return;
                const live = updated || ticket;
                if (commentsDd) {
                    commentsDd.innerHTML = buildHubOperatorResponseCommentsHtml(live, response);
                }
            });
        }
    }

    function closeOperatorResponseStatusModal() {
        const el = document.getElementById('ticketOperatorResponseStatusModal');
        if (el) el.remove();
    }

    function buildHubOperatorResponseCommentsHtml(ticket, response) {
        if (typeof window.formatOperatorResponseCommentsHtml === 'function') {
            return window.formatOperatorResponseCommentsHtml(hubEscapeHtml, ticket, response);
        }
        return window.TICKET_HUB_TEXT.EM_DASH;
    }

    function openOperatorResponseStatusModal(ticket, index) {
        const responses = hubOperatorResponseRowsForIndex(ticket);
        const response = responses[index];
        if (!response) return;
        closeOperatorResponseStatusModal();
        closeHubOperatorResponseDetailModal();
        closeHubResponseCodeDetailModal();
        hubSuppressOutsideCloseUntil = Date.now() + 300;
        const operatorStatus = response.effectiveStatus || response.operatorStatus || 'READY';
        const statusLabel =
            typeof window.formatWorkflowStatusDisplay === 'function'
                ? window.formatWorkflowStatusDisplay(operatorStatus)
                : String(operatorStatus).replace(/_/g, ' ');
        const whyText =
            window.workflowAckModule && typeof window.workflowAckModule.getOperatorStatusExplanation === 'function'
                ? window.workflowAckModule.getOperatorStatusExplanation(operatorStatus, response)
                : '';
        const respondedAt = response.respondedAt ? formatHubDate(response.respondedAt) : window.TICKET_HUB_TEXT.EM_DASH;
        const codeLabel =
            response.statusCode != null && String(response.statusCode).trim() !== ''
                ? String(response.statusCode).trim()
                : window.TICKET_HUB_TEXT.EM_DASH;
        const desc = getHubOperatorResponseCodeDescriptionDisplay(response);
        const descDd =
            desc !== window.TICKET_HUB_TEXT.EM_DASH
                ? hubEscapeHtml(desc)
                : '<span class="ticket-hub-muted">No description available.</span>';
        const commentsHtml = buildHubOperatorResponseCommentsHtml(ticket, response);
        const operatorName = response.operatorName || response.stationCode || response.operatorCode || '';
        const wrap = document.createElement('div');
        wrap.id = 'ticketOperatorResponseStatusModal';
        wrap.className = 'ticket-hub-op-detail-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', 'Operator response status');
        wrap.innerHTML = `
            <div class="ticket-hub-op-detail-panel">
                <div class="ticket-hub-op-detail-header">
                    <h4 class="ticket-hub-op-detail-title">${hubEscapeHtml(operatorName || 'Operator response')}</h4>
                    <button type="button" class="ticket-hub-op-detail-close" aria-label="Close">&times;</button>
                </div>
                <div class="ticket-hub-op-detail-body">
                    <dl class="ticket-history-detail-dl ticket-hub-op-detail-dl">
                        <dt>Status</dt><dd>${hubEscapeHtml(statusLabel)}</dd>
                        <dt>Reason</dt><dd class="ticket-hub-op-detail-reason">${hubEscapeHtml(whyText)}</dd>
                        <dt>Response Code</dt><dd>${hubEscapeHtml(codeLabel)}</dd>
                        <dt>Code Description</dt><dd>${descDd}</dd>
                        <dt>Response Date</dt><dd>${hubEscapeHtml(respondedAt)}</dd>
                        <dt>Comments</dt><dd data-hub-op-comments-dd>${commentsHtml}</dd>
                    </dl>
                    <div class="ticket-hub-op-detail-actions">
                        <button type="button" class="ticket-hub-mini-btn" data-hub-action="op-detail" data-resp-index="${index}">Full operator details</button>
                    </div>
                </div>
            </div>`;
        bindHubOpDetailOverlayDismiss(wrap, closeOperatorResponseStatusModal);
        const panelEl = wrap.querySelector('.ticket-hub-op-detail-panel');
        if (panelEl) {
            bindHubDetailPanelActions(panelEl, ticket);
        }
        wrap.querySelector('.ticket-hub-op-detail-close').addEventListener('click', (e) => {
            e.stopPropagation();
            hubSuppressOutsideCloseUntil = Date.now() + 500;
            closeOperatorResponseStatusModal();
        });
        document.body.appendChild(wrap);

        if (typeof window.ensureNgenProviderResponseHistoryForOperator === 'function') {
            const commentsDd = wrap.querySelector('[data-hub-op-comments-dd]');
            if (commentsDd && commentsHtml === window.TICKET_HUB_TEXT.EM_DASH) {
                commentsDd.innerHTML =
                    '<span class="ticket-responses-comments-loading" aria-busy="true">Loading comments…</span>';
            }
            void window.ensureNgenProviderResponseHistoryForOperator(ticket, response).then((updated) => {
                if (!document.getElementById('ticketOperatorResponseStatusModal')) return;
                const live = updated || ticket;
                if (commentsDd) {
                    commentsDd.innerHTML = buildHubOperatorResponseCommentsHtml(live, response);
                }
            });
        }
    }

    /** Station codes to query the global operator phone directory (ticket list or derived from responses). */
    function getHubDirectoryCodesList(ticket) {
        let codes = Array.isArray(ticket.stationCodes) ? ticket.stationCodes.slice() : [];
        if (!codes.length && ticket.operatorResponses && ticket.operatorResponses.length) {
            codes = [...new Set(ticket.operatorResponses.map(r => r.stationCode || r.operatorCode).filter(Boolean))];
        }
        return codes.map(c => String(c).trim()).filter(Boolean);
    }

    /**
     * Loads `station_operator_phones` rows for this ticket's codes; caches a Map on the ticket for reuse.
     * @returns {Promise<Map<string, object>>}
     */
    async function loadHubOperatorDirectoryMap(ticket) {
        const codes = getHubDirectoryCodesList(ticket);
        const cacheKey = codes.slice().sort().join('|');
        if (ticket.__hubDirCacheKey === cacheKey && ticket.__hubDirMap) {
            return ticket.__hubDirMap;
        }
        const emptyMap = new Map();
        if (!codes.length || !window.authModule) {
            ticket.__hubDirCacheKey = cacheKey;
            ticket.__hubDirMap = emptyMap;
            return emptyMap;
        }
        try {
            const q = encodeURIComponent(codes.join(','));
            const data = await window.authModule.apiRequest(`tickets/station-operator-phones?codes=${q}`);
            const entries = data && Array.isArray(data.entries) ? data.entries : [];
            const map = new Map();
            entries.forEach(en => {
                const sc = en.station_code != null ? String(en.station_code).trim() : '';
                if (sc) map.set(sc, en);
            });
            ticket.__hubDirCacheKey = cacheKey;
            ticket.__hubDirMap = map;
            return map;
        } catch (e) {
            ticket.__hubDirCacheKey = cacheKey;
            ticket.__hubDirMap = emptyMap;
            return emptyMap;
        }
    }

    function findHubDirectoryEntryForResponse(map, response) {
        const code = String(response.stationCode || response.operatorCode || '').trim();
        if (!code || !map) return null;
        if (map.has(code)) return map.get(code);
        const lower = code.toLowerCase();
        for (const [k, v] of map) {
            if (String(k).toLowerCase() === lower) return v;
        }
        return null;
    }

    /**
     * Provider payload may store `nameWithPhoneNumbers` like: "Acme Utility     (Phone: 7025550100     Emergency: 8005550199)".
     * Returns labeled numbers only (no operator name). Phone -> "Regular", Emergency -> "Emergency".
     * @param {string|null|undefined} raw
     * @returns {string|null}
     */
    function extractPhoneNumbersFromNameWithPhones(raw) {
        if (raw == null) return null;
        const s = String(raw).trim();
        if (!s) return null;
        const parts = [];
        function labelForKind(kind) {
            const k = String(kind || '').toLowerCase();
            if (k === 'phone') return 'Regular';
            if (k === 'emergency') return 'Emergency';
            if (k === 'fax') return 'Fax';
            if (k === 'mobile') return 'Mobile';
            return 'Number';
        }
        const labeled = /(Phone|Emergency|Fax|Mobile)\s*:\s*([\d\s().\-]+)/gi;
        let m;
        while ((m = labeled.exec(s)) !== null) {
            const digits = String(m[2]).replace(/\D/g, '');
            if (digits.length < 7 || digits.length > 15) continue;
            parts.push(`${labelForKind(m[1])}: ${digits}`);
        }
        if (parts.length) {
            return parts.join(` ${window.TICKET_HUB_TEXT.MIDDLE_DOT} `);
        }
        const runs = s.match(/\d{7,15}/g);
        if (runs) {
            runs.forEach(r => {
                if (r.length >= 7 && r.length <= 15) parts.push(`Number: ${r}`);
            });
        }
        return parts.length ? parts.join(` ${window.TICKET_HUB_TEXT.MIDDLE_DOT} `) : null;
    }

    function formatHubDirectoryDetailHtml(entry) {
        if (!entry) {
            return '<p class="ticket-hub-muted" style="margin:0;font-size:0.8rem;">No directory row for this station. After sync includes notifications with phone data, refresh the ticket.</p>';
        }
        const phonesOnly = extractPhoneNumbersFromNameWithPhones(entry.name_with_phones);
        const phonesDisplay = phonesOnly != null ? phonesOnly : window.TICKET_HUB_TEXT.EM_DASH;
        return `<dl class="ticket-history-detail-dl ticket-hub-op-detail-dl ticket-hub-op-detail-dir-dl">
            <dt>Phones</dt><dd>${hubEscapeHtml(phonesDisplay)}</dd>
            <dt>Utility Type</dt><dd>${hubEscapeHtml(String(entry.industry || window.TICKET_HUB_TEXT.EM_DASH))}</dd>
        </dl>`;
    }

    function openHubOperatorResponseDetailModal(ticket, index) {
        const responses = hubOperatorResponseRowsForIndex(ticket);
        const response = responses[index];
        if (!response) return;
        closeHubOperatorResponseDetailModal();
        closeHubResponseCodeDetailModal();
        closeOperatorResponseStatusModal();
        hubSuppressOutsideCloseUntil = Date.now() + 300;
        const isOutstanding =
            ticket.outstandingOperators &&
            (ticket.outstandingOperators.includes(response.operatorName) ||
                ticket.outstandingOperators.includes(response.stationCode));
        const respondedAt = response.respondedAt ? formatHubDate(response.respondedAt) : window.TICKET_HUB_TEXT.EM_DASH;
        const operatorStatus = response.effectiveStatus || response.operatorStatus || 'READY';
        const code = response.stationCode || response.operatorCode || '';
        const codeEsc = hubEscapeHtml(code);
        const codeDescDisplay = getHubOperatorResponseCodeDescriptionDisplay(response);
        const codeDescDd =
            codeDescDisplay !== window.TICKET_HUB_TEXT.EM_DASH
                ? hubEscapeHtml(codeDescDisplay)
                : '<span class="ticket-hub-muted">No description available.</span>';
        const commentsDdHtml =
            typeof window.formatOperatorResponseCommentsHtml === 'function'
                ? window.formatOperatorResponseCommentsHtml(hubEscapeHtml, ticket, response)
                : window.TICKET_HUB_TEXT.EM_DASH;
        const wrap = document.createElement('div');
        wrap.id = 'ticketHubOperatorResponseDetailModal';
        wrap.className = 'ticket-hub-op-detail-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-modal', 'true');
        wrap.setAttribute('aria-label', 'Operator response details');
        const outstandingNote = isOutstanding ? '<p class="ticket-hub-op-detail-outstanding">Outstanding for this ticket</p>' : '';
        wrap.innerHTML = `
            <div class="ticket-hub-op-detail-panel">
                <div class="ticket-hub-op-detail-header">
                    <h4 class="ticket-hub-op-detail-title">Operator response</h4>
                    <button type="button" class="ticket-hub-op-detail-close" aria-label="Close">&times;</button>
                </div>
                <div class="ticket-hub-op-detail-body">
                    <dl class="ticket-history-detail-dl ticket-hub-op-detail-dl">
                        <dt>Station Code</dt><dd>${code ? codeEsc : window.TICKET_HUB_TEXT.EM_DASH}</dd>
                        <dt>Station Code Name</dt><dd>${hubEscapeHtml(response.operatorName || window.TICKET_HUB_TEXT.EM_DASH)}</dd>
                        <dt>Response Date</dt><dd>${hubEscapeHtml(respondedAt)}</dd>
                        <dt>Response Code</dt><dd>${hubEscapeHtml(response.statusCode != null ? String(response.statusCode) : window.TICKET_HUB_TEXT.EM_DASH)}</dd>
                        <dt>Code Description</dt><dd>${codeDescDd}</dd>
                        <dt>Status</dt><dd>${hubEscapeHtml(window.formatWorkflowStatusDisplay(operatorStatus))}</dd>
                        <dt>Comments</dt><dd>${commentsDdHtml}</dd>
                    </dl>
                    ${outstandingNote}
                    <div class="ticket-hub-op-detail-directory">
                        <h5 class="ticket-hub-op-detail-subtitle">Operator directory</h5>
                        <div id="ticketHubOpDetailDirectoryBody" class="ticket-hub-async-block">Loading...</div>
                    </div>
                </div>
            </div>`;
        bindHubOpDetailOverlayDismiss(wrap, closeHubOperatorResponseDetailModal);
        const panelEl = wrap.querySelector('.ticket-hub-op-detail-panel');
        if (panelEl) {
            bindHubDetailPanelActions(panelEl, ticket);
        }
        wrap.querySelector('.ticket-hub-op-detail-close').addEventListener('click', (e) => {
            e.stopPropagation();
            hubSuppressOutsideCloseUntil = Date.now() + 500;
            closeHubOperatorResponseDetailModal();
        });
        document.body.appendChild(wrap);
        const dirBody = wrap.querySelector('#ticketHubOpDetailDirectoryBody');
        void loadHubOperatorDirectoryMap(ticket).then(map => {
            if (!dirBody || !document.body.contains(wrap)) return;
            const entry = findHubDirectoryEntryForResponse(map, response);
            dirBody.innerHTML = formatHubDirectoryDetailHtml(entry);
        });
    }

    function buildHubCheckPosrButtonHtml() {
        return `<button type="button" class="ticket-posr-portal-btn" data-hub-action="check-posr" title="Copy ticket number to clipboard and open external search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Check POSR
        </button>`;
    }

    function buildHubOperatorResponsesHtml(ticket, _isMobile, opts) {
        const forTabs = opts && opts.forTabs;
        if (
            typeof window.isPosrLaneTicket === 'function' &&
            window.isPosrLaneTicket(ticket)
        ) {
            const blurbBody =
                typeof window.buildPosrPortalDetailsBlurbHtml === 'function'
                    ? window.buildPosrPortalDetailsBlurbHtml({ forHub: true })
                    : '';
            if (forTabs) {
                return `<div class="ticket-detail-tab-panel-inner">${blurbBody}</div>`;
            }
            return `
            <div class="ticket-hub-operator-section ticket-hub-collapsible-section" data-ticket-hub-collapsible>
                <div class="ticket-hub-collapsible-header">
                    <button type="button" class="ticket-hub-section-title ticket-hub-collapse-toggle" data-ticket-hub-collapse-toggle aria-expanded="true">Operator responses</button>
                </div>
                <div class="ticket-hub-collapsible-body">
                    ${blurbBody}
                </div>
            </div>`;
        }
        const checkPosrBtn = buildHubCheckPosrButtonHtml();
        const posrOpsDeferred =
            window.ticketsModule &&
            typeof window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState === 'function' &&
            window.ticketsModule.shouldDeferPosrOperatorResponsesEmptyState(ticket);
        const canShowResponses =
            window.ticketsModule &&
            typeof window.ticketsModule.canShowTicketOperatorResponsesNow === 'function' &&
            window.ticketsModule.canShowTicketOperatorResponsesNow(ticket) &&
            !posrOpsDeferred;
        const responsesLoadPending =
            posrOpsDeferred ||
            (!canShowResponses &&
                window.ticketsModule &&
                typeof window.ticketsModule.isTicketOperatorResponsesLoadPending === 'function' &&
                window.ticketsModule.isTicketOperatorResponsesLoadPending(ticket));
        if (responsesLoadPending) {
            const loadingBody =
                typeof window.buildTicketResponsesLoadingHtml === 'function'
                    ? window.buildTicketResponsesLoadingHtml()
                    : '<div class="ticket-responses-loading" aria-busy="true">Loading operator responses…</div>';
            if (forTabs) {
                return wrapHubOperatorResponsesForTabs(loadingBody, checkPosrBtn);
            }
            return `
            <div class="ticket-hub-operator-section ticket-hub-collapsible-section" data-ticket-hub-collapsible>
                <div class="ticket-hub-collapsible-header">
                    <button type="button" class="ticket-hub-section-title ticket-hub-collapse-toggle" data-ticket-hub-collapse-toggle aria-expanded="true">Operator responses</button>
                    ${checkPosrBtn}
                </div>
                <div class="ticket-hub-collapsible-body">
                    ${loadingBody}
                </div>
            </div>`;
        }
        const operatorResponses =
            window.ticketsModule && typeof window.ticketsModule.ticketOperatorResponseRowsForDisplay === 'function'
                ? window.ticketsModule.ticketOperatorResponseRowsForDisplay(ticket)
                : ticket.operatorResponses || [];
        if (operatorResponses.length === 0) {
            const emptyBody =
                typeof window.buildTicketResponsesEmptyHtml === 'function'
                    ? window.buildTicketResponsesEmptyHtml()
                    : `<div class="ticket-responses-empty"><p>${
                          typeof window.t === 'function'
                              ? window.t('No operator responses available')
                              : 'No operator responses available'
                      }</p></div>`;
            if (forTabs) {
                return wrapHubOperatorResponsesForTabs(emptyBody, checkPosrBtn);
            }
            return `
            <div class="ticket-hub-operator-section ticket-hub-collapsible-section" data-ticket-hub-collapsible>
                <div class="ticket-hub-collapsible-header">
                    <button type="button" class="ticket-hub-section-title ticket-hub-collapse-toggle" data-ticket-hub-collapse-toggle aria-expanded="true">Operator responses</button>
                    ${checkPosrBtn}
                </div>
                <div class="ticket-hub-collapsible-body">
                    ${emptyBody}
                </div>
            </div>`;
        }
        const cardsBody =
            typeof window.buildOperatorResponseCardsListHtml === 'function'
                ? window.buildOperatorResponseCardsListHtml(ticket, operatorResponses, { context: 'hub' })
                : '';
        if (forTabs) {
            return wrapHubOperatorResponsesForTabs(cardsBody, checkPosrBtn);
        }
        return `
            <div class="ticket-hub-operator-section ticket-hub-collapsible-section" data-ticket-hub-collapsible>
                <div class="ticket-hub-collapsible-header">
                    <button type="button" class="ticket-hub-section-title ticket-hub-collapse-toggle" data-ticket-hub-collapse-toggle aria-expanded="true">Operator responses</button>
                    ${checkPosrBtn}
                </div>
                <div class="ticket-hub-collapsible-body">
                    ${cardsBody}
                </div>
            </div>`;
    }

    function injectHubAuxiliaryDetailData(container, ticket) {
        if (!container || !ticket) return;
        void loadHubOperatorDirectoryMap(ticket);
    }


