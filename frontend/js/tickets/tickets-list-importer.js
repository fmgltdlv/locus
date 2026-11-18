
/**
 * Resolved job name for UI and search (aligned with ticket hub: pickJobName ? jobName, providerUserReference, jobNumberName).
 * @param {object} ticket
 * @returns {string} trimmed display string, or empty when none
 */
function getTicketJobNameDisplayValue(ticket) {
    const thdm = window.ticketHubDisplayMap;
    if (thdm && typeof thdm.pickTicketField === 'function') {
        const v = thdm.pickTicketField(ticket, 'jobName');
        if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    const raw = ticket.jobName || ticket.providerUserReference || ticket.jobNumberName;
    return raw != null && String(raw).trim() !== '' ? String(raw).trim() : '';
}

/**
 * @param {object} ticket
 * @returns {string} lowercased string for substring search, may be empty
 */
function ticketJobNameForListSearch(ticket) {
    const s = getTicketJobNameDisplayValue(ticket);
    return s ? s.toLowerCase() : '';
}

function matchesSidebarTicketListSearch(ticket, searchText) {
    if (!ticket) return false;
    const q = String(searchText || '').toLowerCase();
    if (!q) return true;

    const mod = window.ticketImporterModule;
    const normalizeBase =
        mod && typeof mod.normalizeTicketBase === 'function'
            ? mod.normalizeTicketBase
            : function (tn) {
                  return String(tn || '').split('-')[0];
              };
    const tnLower = String(ticket.ticketNumber || '').toLowerCase();
    const baseLower = String(normalizeBase(ticket.ticketNumber || '') || '').toLowerCase();
    const jobLower = ticketJobNameForListSearch(ticket);

    return (
        tnLower.includes(q) ||
        baseLower.includes(q) ||
        (ticket.locationSummary && ticket.locationSummary.toLowerCase().includes(q)) ||
        (ticket.workDescription && ticket.workDescription.toLowerCase().includes(q)) ||
        (ticket.address && ticket.address.toLowerCase().includes(q)) ||
        (jobLower && jobLower.includes(q))
    );
}

function filterTickets() {
    const searchInput = document.getElementById('ticketSearchInput');
    const statusFilter = document.getElementById('ticketStatusFilter');
    const dateRangeFilter = document.getElementById('ticketSidebarDateRange');
    const sortFilter = document.getElementById('ticketListSort');

    if (searchInput) {
        ticketListSearch = searchInput.value.toLowerCase();
    }
    if (statusFilter) {
        ticketListStatusFilter = normalizeSidebarTicketStatusFilter(statusFilter.value);
        if (statusFilter.value !== ticketListStatusFilter) {
            statusFilter.value = ticketListStatusFilter;
        }
    }
    if (sortFilter) {
        ticketListSort = normalizeTicketListSort(sortFilter.value);
        if (sortFilter.value !== ticketListSort) {
            sortFilter.value = ticketListSort;
        }
    }
    if (dateRangeFilter) {
        ticketListDateRangeFilter = normalizeSidebarTicketDateRange(dateRangeFilter.value);
        if (dateRangeFilter.value !== ticketListDateRangeFilter) {
            dateRangeFilter.value = ticketListDateRangeFilter;
        }
    }

    renderTicketList();
    renderTickets();
}

/** Set by {@link loadTicketsForCurrentOrg} - lowercased provider names for the selected org (master + subs). */
// window.TICKET_HUB_ORG_USERNAMES - array of strings

/**
 * Display label for shared source organization.
 * @param {object} ticket
 * @returns {string}
 */
function getTicketSharedSourceLabel(ticket) {
    if (!ticket || !ticket.shared) return '';
    const label = ticket && ticket.sharedSourceLabel != null ? String(ticket.sharedSourceLabel).trim() : '';
    return label || 'Partner organization';
}

function getTicketExternalBadgeHtml(ticket) {
    if (!ticketIsExternalOrg(ticket)) return '';
    if (ticket && ticket.shared) {
        const sharedSourceLabel = getTicketSharedSourceLabel(ticket);
        return ` <span class="ticket-card-external" title="Shared from ${escapeHtmlTicketUi(sharedSourceLabel)}">External: ${escapeHtmlTicketUi(sharedSourceLabel)}</span>`;
    }
    if (ticketIsExplicitExternalImportForOrg(ticket)) {
        return ' <span class="ticket-card-external" title="Imported manually for this organization via POSR import">External</span>';
    }
    const lodgedBy = ticket && ticket.lodgedByUserName != null ? String(ticket.lodgedByUserName).trim() : '';
    const title = lodgedBy
        ? `Lodged by ${lodgedBy}, which is not a provider account in this organization`
        : 'Lodged by user is not a provider account in this organization';
    return ` <span class="ticket-card-external" title="${escapeHtmlTicketUi(title)}">External</span>`;
}

const TICKET_LIST_VIRTUAL_ROW_HEIGHT_FALLBACK = 118;
const TICKET_LIST_VIRTUAL_OVERSCAN = 4;
const ticketListVirtualState = {
    displayTickets: [],
    rowHeight: TICKET_LIST_VIRTUAL_ROW_HEIGHT_FALLBACK,
    scrollRaf: null,
    frozenDisplayTickets: null,
    lastSliceIds: [],
    lastStartIndex: 0,
};

function clearProgressiveTicketListLoadState() {
    clearTicketListFrozenDisplayOrder();
    resetTicketListVirtualSliceCache();
}

function clearTicketListFrozenDisplayOrder() {
    ticketListVirtualState.frozenDisplayTickets = null;
}

function resetTicketListVirtualSliceCache() {
    ticketListVirtualState.lastSliceIds = [];
    ticketListVirtualState.lastStartIndex = 0;
}

function isProgressiveTicketListLoad() {
    return typeof isTicketListSummaryLoadBusy === 'function' && isTicketListSummaryLoadBusy();
}

function formatTicketListProgressiveCountLabel(displayCount) {
    if (typeof isTicketListSummaryLoadBusy === 'function' && isTicketListSummaryLoadBusy()) {
        return 'Loading tickets';
    }
    return String(displayCount);
}

function getSidebarDisplayTickets(tickets) {
    const mod = window.ticketImporterModule;
    const isPublicCatalog =
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer();
    const effectiveStatusFilter = isPublicCatalog ? 'ALL' : ticketListStatusFilter;
    const normalizeBase =
        mod && typeof mod.normalizeTicketBase === 'function'
            ? mod.normalizeTicketBase
            : function (tn) {
                  return String(tn || '').split('-')[0];
              };
    const filteredTickets = (tickets || []).filter(ticket => {
        const matchesSearch = matchesSidebarTicketListSearch(ticket, ticketListSearch);
        const matchesStatus = matchesSidebarTicketListStatusFilter(ticket, effectiveStatusFilter);
        const matchesDateRange = isPublicCatalog ? true : matchesSidebarTicketDateRange(ticket);

        return matchesSearch && matchesStatus && matchesDateRange;
    });
    const displayTickets =
        mod && typeof mod.dedupeTicketsByBase === 'function' ? mod.dedupeTicketsByBase(filteredTickets) : filteredTickets;

    if (isProgressiveTicketListLoad()) {
        if (!ticketListVirtualState.frozenDisplayTickets) {
            displayTickets.sort((a, b) =>
                compareTicketsForListSort(a, b, ticketListSort, normalizeBase)
            );
            ticketListVirtualState.frozenDisplayTickets = displayTickets.slice();
            return displayTickets;
        }
        const frozen = ticketListVirtualState.frozenDisplayTickets;
        const frozenIds = new Set(frozen.map((ticket) => String(ticket.id)));
        const frozenById = new Map(frozen.map((ticket) => [String(ticket.id), ticket]));
        displayTickets.forEach((ticket) => {
            const id = String(ticket.id);
            if (frozenById.has(id)) frozenById.set(id, ticket);
        });
        const merged = frozen.map((ticket) => frozenById.get(String(ticket.id)) || ticket);
        displayTickets.forEach((ticket) => {
            const id = String(ticket.id);
            if (!frozenIds.has(id)) {
                merged.push(ticket);
                frozenIds.add(id);
            }
        });
        ticketListVirtualState.frozenDisplayTickets = merged;
        return merged;
    }

    ticketListVirtualState.frozenDisplayTickets = null;
    if (isPublicCatalog) {
        return displayTickets;
    }
    displayTickets.sort((a, b) =>
        compareTicketsForListSort(a, b, ticketListSort, normalizeBase)
    );
    return displayTickets;
}

function buildTicketCardHtml(ticket) {
    const mod = window.ticketImporterModule;
    const parseParts =
        mod && typeof mod.parseTicketNumberParts === 'function'
            ? mod.parseTicketNumberParts
            : function (t) {
                  const raw = String((t && t.ticketNumber) || '').trim();
                  const idx = raw.indexOf('-');
                  if (idx === -1) return { baseNumber: raw, revisionSuffix: null };
                  return { baseNumber: raw.slice(0, idx), revisionSuffix: raw.slice(idx + 1) || null };
              };
    const isSelected = ticketIdEquals(ticket.id, selectedTicketId);
    const numParts = parseParts(ticket);
    const revLabel =
        mod && typeof mod.resolveRevisionLabelForTicket === 'function'
            ? mod.resolveRevisionLabelForTicket(ticket)
            : numParts.revisionSuffix;
    const numHtml =
        revLabel != null && revLabel !== ''
            ? `#${escapeHtmlTicketUi(numParts.baseNumber)}<span class="ticket-card-rev">-${escapeHtmlTicketUi(revLabel)}</span>`
            : `#${escapeHtmlTicketUi(numParts.baseNumber || ticket.ticketNumber || '')}`;

    let statusClass = 'ready';
    let statusText = 'READY';
    switch (ticket.status) {
        case 'READY':
            statusClass = 'ready';
            statusText = 'READY';
            break;
        case 'NOT_READY':
            statusClass = 'not-ready';
            statusText = 'NOT READY';
            break;
        case 'ACTION_REQUIRED':
            statusClass = 'action-required';
            statusText = 'REVIEW REQUIRED';
            break;
        case 'EXPIRED':
            statusClass = 'expired';
            statusText = 'EXPIRED';
            break;
        case 'CANCELLED':
            statusClass = 'cancelled';
            statusText = 'CANCELLED';
            break;
        case 'EXPIRING_SOON':
            statusClass = 'expiring-soon';
            statusText = 'EXPIRING SOON';
            break;
    }

    const responseProgress = getTicketResponseProgress(ticket);
    const operatorCount =
        responseProgress.required != null ? responseProgress.required : responseProgress.received;
    const outstandingCount = responseProgress.outstanding != null ? responseProgress.outstanding : 0;
    const endsAt = getTicketExpirationForDisplay(ticket) || ticket.endTime;
    const externalBadge = getTicketExternalBadgeHtml(ticket);
    const refreshBusy =
        typeof ticketSelectionRefreshLoading === 'function' && ticketSelectionRefreshLoading(ticket);
    const refreshLockHtml = refreshBusy
        ? `<div class="ticket-card-refresh-lock" aria-busy="true" aria-live="polite"><div class="ticket-card-refresh-inner">${typeof window.getAppLoaderHtml === 'function' ? window.getAppLoaderHtml() : '<div class="app-loading-indicator" role="status" aria-label="Loading"></div>'}<p class="ticket-card-refresh-text">Refreshing ticket-</p></div></div>`
        : '';
    const isPublicCatalog =
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer();
    const statusBadgeFallback = `<span class="ticket-card-status ${statusClass}">${statusText}</span>`;
    const wm = window.workflowAckModule;
    const statusBadgeHtml = isPublicCatalog
        ? ''
        : wm && typeof wm.preferCoreStatusIndicatorHtml === 'function'
          ? wm.preferCoreStatusIndicatorHtml(ticket.status, statusBadgeFallback)
          : statusBadgeFallback;
    const publicOrgLabel = isPublicCatalog ? getTicketSharedSourceLabel(ticket) : '';
    const publicOrgHtml = publicOrgLabel
        ? `<div class="ticket-card-org">Organization: ${escapeHtmlTicketUi(publicOrgLabel)}</div>`
        : '';
    // Public catalog already shows Organization below; skip the compact External badge there.
    const cardExternalBadge = isPublicCatalog ? '' : externalBadge;

    const addrRaw = String(ticket.address || ticket.locationSummary || '').trim();
    const jobRaw = getTicketJobNameDisplayValue(ticket);
    const addrDisp = addrRaw || '-';
    let sublineHtml = '';
    if (jobRaw && addrRaw) {
        const title = addrRaw + ' · ' + jobRaw;
        sublineHtml =
            `<div class="ticket-card-subline" title="${escapeHtmlTicketUi(title)}">` +
            `<span class="ticket-card-subline-address">${escapeHtmlTicketUi(addrRaw)}</span>` +
            `<span class="ticket-card-subline-sep" aria-hidden="true">·</span>` +
            `<span class="ticket-card-subline-job">${escapeHtmlTicketUi(jobRaw)}</span>` +
            '</div>';
    } else if (jobRaw) {
        sublineHtml = `<div class="ticket-card-subline" title="${escapeHtmlTicketUi(jobRaw)}"><span class="ticket-card-subline-job ticket-card-subline-job--solo">${escapeHtmlTicketUi(jobRaw)}</span></div>`;
    } else {
        sublineHtml = `<div class="ticket-card-subline" title="${escapeHtmlTicketUi(addrDisp)}"><span class="ticket-card-subline-address ticket-card-subline-address--solo">${escapeHtmlTicketUi(addrDisp)}</span></div>`;
    }

    return `
        <div class="ticket-card ${isSelected ? 'selected' : ''}" data-ticket-id="${escapeHtmlTicketUi(ticket.id)}">
            <div class="ticket-card-top">
                <div class="ticket-card-number"><span class="ticket-card-num-line">${numHtml}</span>${cardExternalBadge}</div>
                ${statusBadgeHtml}
            </div>
            ${publicOrgHtml}
            ${sublineHtml}
            <div class="ticket-card-dates">
                <span>Start: ${formatDate(ticket.startTime)}</span>
                <span>Ends: ${endsAt ? formatDate(endsAt) : '-'}</span>
            </div>
            <div class="ticket-card-meta">
                <span>Operators: ${operatorCount}</span>
                <span>Outstanding: ${outstandingCount > 0 ? outstandingCount : 'None'}</span>
            </div>
            ${refreshLockHtml}
        </div>
    `;
}

function ensureTicketListVirtualDom(content) {
    if (!content) return null;
    if (content.getAttribute('data-ticket-list-virtual') !== '1') {
        content.innerHTML = '<div class="ticket-list-virtual-spacer"></div><div class="ticket-list-virtual-window"></div>';
        content.setAttribute('data-ticket-list-virtual', '1');
    }
    if (content.getAttribute('data-ticket-list-click-bound') !== '1') {
        content.addEventListener('click', function (event) {
            const card = event.target && event.target.closest ? event.target.closest('.ticket-card[data-ticket-id]') : null;
            if (!card || !content.contains(card)) return;
            selectTicketFromList(card.getAttribute('data-ticket-id'));
        });
        content.setAttribute('data-ticket-list-click-bound', '1');
    }
    if (content.getAttribute('data-ticket-list-scroll-bound') !== '1') {
        content.addEventListener('scroll', function () {
            if (ticketListVirtualState.scrollRaf) return;
            ticketListVirtualState.scrollRaf = requestAnimationFrame(function () {
                ticketListVirtualState.scrollRaf = null;
                renderTicketListVirtualSlice(content);
            });
        }, { passive: true });
        content.setAttribute('data-ticket-list-scroll-bound', '1');
    }
    return {
        spacer: content.querySelector('.ticket-list-virtual-spacer'),
        windowEl: content.querySelector('.ticket-list-virtual-window'),
    };
}

function appendTicketCardToWindow(windowEl, ticket) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildTicketCardHtml(ticket).trim();
    const card = wrapper.firstElementChild;
    if (card) windowEl.appendChild(card);
    return card;
}

function renderTicketListVirtualSlice(content) {
    const dom = ensureTicketListVirtualDom(content);
    if (!dom || !dom.spacer || !dom.windowEl) return;
    const displayTickets = ticketListVirtualState.displayTickets || [];
    const rowHeight = Math.max(1, ticketListVirtualState.rowHeight || TICKET_LIST_VIRTUAL_ROW_HEIGHT_FALLBACK);
    const viewportHeight = content.clientHeight || rowHeight * 8;
    const startIndex = Math.max(0, Math.floor(content.scrollTop / rowHeight) - TICKET_LIST_VIRTUAL_OVERSCAN);
    const visibleCount = Math.ceil(viewportHeight / rowHeight) + (TICKET_LIST_VIRTUAL_OVERSCAN * 2);
    const endIndex = Math.min(displayTickets.length, startIndex + visibleCount);
    const slice = displayTickets.slice(startIndex, endIndex);
    const sliceIds = slice.map((ticket) => String(ticket.id));
    const prevSliceIds = ticketListVirtualState.lastSliceIds || [];
    const sliceUnchanged =
        sliceIds.length === prevSliceIds.length &&
        sliceIds.every((id, index) => id === prevSliceIds[index]);
    const sliceExtended =
        isProgressiveTicketListLoad() &&
        ticketListVirtualState.lastStartIndex === startIndex &&
        sliceIds.length > prevSliceIds.length &&
        prevSliceIds.every((id, index) => sliceIds[index] === id);

    dom.spacer.style.height = `${displayTickets.length * rowHeight}px`;
    dom.windowEl.style.transform = `translateY(${startIndex * rowHeight}px)`;

    if (sliceUnchanged && ticketListVirtualState.lastStartIndex === startIndex) {
        ticketListVirtualState.lastSliceIds = sliceIds;
        ticketListVirtualState.lastStartIndex = startIndex;
    } else if (sliceExtended) {
        slice.slice(prevSliceIds.length).forEach((ticket) => appendTicketCardToWindow(dom.windowEl, ticket));
        ticketListVirtualState.lastSliceIds = sliceIds;
        ticketListVirtualState.lastStartIndex = startIndex;
    } else {
        dom.windowEl.innerHTML = slice.map(buildTicketCardHtml).join('');
        ticketListVirtualState.lastSliceIds = sliceIds;
        ticketListVirtualState.lastStartIndex = startIndex;
    }

    const firstCard = dom.windowEl.querySelector('.ticket-card');
    if (firstCard) {
        const gapRaw = window.getComputedStyle(dom.windowEl).rowGap || window.getComputedStyle(dom.windowEl).gap || '0';
        const gap = Number.parseFloat(gapRaw) || 0;
        const measured = Math.ceil(firstCard.getBoundingClientRect().height + gap);
        if (Number.isFinite(measured) && measured > 0 && Math.abs(measured - rowHeight) > 2) {
            ticketListVirtualState.rowHeight = measured;
            dom.spacer.style.height = `${displayTickets.length * measured}px`;
            dom.windowEl.style.transform = `translateY(${startIndex * measured}px)`;
        }
    }
    if (window.overlayScrollModule?.syncOverlayScroll) {
        window.overlayScrollModule.syncOverlayScroll(content);
    }
}

function renderTicketList() {
    if (typeof window.renderHubTable === 'function') {
        window.renderHubTable();
    }
}

function selectTicketFromList(ticketId) {
    if (
        typeof window.isCurrentOrgPublicCatalogViewer === 'function' &&
        window.isCurrentOrgPublicCatalogViewer() &&
        typeof window.selectPublicCatalogTicketFromList === 'function'
    ) {
        window.selectPublicCatalogTicketFromList(ticketId);
        return;
    }
    selectTicket(ticketId);
}

// Open ticket importer modal
async function openTicketImporter() {
    const currentOrgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    const canEdit = typeof window.canEditCurrentOrg === 'function' && window.canEditCurrentOrg();
    if (!currentOrgId || !canEdit) {
        await appAlert('Please select an organization you belong to (from the organization selector) before importing tickets. Imported tickets are stored in the currently selected organization.');
        return;
    }
    if (window.authModule && window.authModule.isTechInCurrentOrg && window.authModule.isTechInCurrentOrg()) {
        await appAlert('You do not have permission to import tickets.');
        return;
    }
    const modal = document.getElementById('ticketImporterModal');
    if (modal) {
        modal.style.display = 'flex';
        // Update org note with current org name if selector is available
        const orgNote = document.getElementById('ticketImporterOrgNote');
        if (orgNote) {
            const selector = document.getElementById('orgSelector');
            const orgName = selector && selector.options[selector.selectedIndex] ? selector.options[selector.selectedIndex].text.replace(/\s*\(Default\)\s*$|\s*\(Not a member\)\s*$/i, '').trim() : '';
            orgNote.textContent = orgName ? `Tickets will be stored in your currently selected organization: ${orgName}.` : 'Tickets will be stored in your currently selected organization.';
        }
        // Clear previous input and progress
        const input = document.getElementById('ticketImporterInput');
        const progress = document.getElementById('ticketImporterProgress');
        if (input) input.value = '';
        if (progress) {
            progress.style.display = 'none';
            // Reset progress content
            progress.innerHTML = `
                <div class="spinner" style="width: 40px; height: 40px; border: 4px solid var(--app-bg-muted); border-top: 4px solid var(--app-accent); border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 1rem;"></div>
                <div id="ticketImporterStatus" style="color: var(--app-text-secondary); font-size: 0.875rem; text-align: center;">Processing tickets...</div>
            `;
        }
    }
}

// Close ticket importer modal
function closeTicketImporter() {
    const modal = document.getElementById('ticketImporterModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Import tickets from NV API
async function importTickets() {
    const currentOrgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    const canEdit = typeof window.canEditCurrentOrg === 'function' && window.canEditCurrentOrg();
    if (!currentOrgId || !canEdit) {
        await appAlert('Please select an organization you belong to before importing. Imported tickets are stored in the currently selected organization.');
        return;
    }
    if (window.authModule && window.authModule.isTechInCurrentOrg && window.authModule.isTechInCurrentOrg()) {
        await appAlert('You do not have permission to import tickets.');
        return;
    }
    const input = document.getElementById('ticketImporterInput');
    const throttleInput = document.getElementById('ticketImporterThrottle');
    const progress = document.getElementById('ticketImporterProgress');
    const submitBtn = document.getElementById('ticketImporterSubmit');
    
    if (!input || !progress) return;
    
    const rawInput = input.value.trim();
    if (!rawInput) {
        await appAlert('Please enter at least one ticket number.');
        return;
    }
    
    // Parse ticket numbers (split by newline or comma)
    const ticketNumbers = [];
    for (const line of rawInput.split('\n')) {
        for (const piece of line.split(',')) {
            const ticket = piece.trim();
            if (ticket) {
                ticketNumbers.push(ticket);
            }
        }
    }
    
    // Remove duplicates while preserving order
    const uniqueTickets = Array.from(new Set(ticketNumbers));
    
    if (uniqueTickets.length === 0) {
        await appAlert('No valid ticket numbers found.');
        return;
    }
    
    // Use default throttle of 500ms
    const throttleMs = 500;
    
    // Disable submit button
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing...';
    }
    
    // Get status element before defining log function
    const statusElement = document.getElementById('ticketImporterStatus');
    
    // Show progress with spinner
    if (progress) {
        progress.style.display = 'flex';
        if (statusElement) {
            statusElement.textContent = 'Processing tickets...';
        }
        // Make sure spinner is visible
        const spinner = progress.querySelector('.spinner');
        if (spinner) {
            spinner.style.display = 'block';
        }
    }
    
    // Progress logger - updates status text
    const log = (message) => {
        if (statusElement) {
            statusElement.textContent = message;
        }
    };
    
    try {
        // Check if ticket importer module is available
        if (!window.ticketImporterModule) {
            throw new Error('Ticket importer module not loaded');
        }
        
        // Process tickets
        const result = await window.ticketImporterModule.processTickets(
            uniqueTickets,
            log,
            throttleMs
        );
        
        const errorMessages =
            result.errors.length > 0
                ? result.errors
                      .map((err) => {
                          if (err.error && err.error.includes('CORS_ERROR')) {
                              return `CORS Error: The NV API requires a proxy server or backend endpoint. Direct browser requests are blocked.`;
                          }
                          return `${err.ticketNumber}: ${err.error}`;
                      })
                      .join('\n')
                : '';

        if (result.tickets.length > 0) {
            const tm = window.ticketsModule;
            // Add tickets to map (already saved by POST /api/tickets/import)
            window.ticketImporterModule.addTicketsToMap(result.tickets, { alreadySaved: true });
            if (tm && typeof tm.mergeImportedTicketsIntoOrgList === 'function') {
                tm.mergeImportedTicketsIntoOrgList(result.tickets);
            }
            if (result.errors.length > 0) {
                console.warn('Some ticket imports failed:\n' + errorMessages);
                log(
                    `✓ Imported ${result.tickets.length} ticket(s); ${result.errors.length} failed (see console).`
                );
            } else {
                log(`✓ Successfully imported ${result.tickets.length} ticket(s)!`);
            }
            if (tm) {
                if (typeof tm.renderTickets === 'function') tm.renderTickets({ force: true });
                if (typeof tm.renderTicketList === 'function') tm.renderTicketList();
                if (window.ticketHubModule && typeof window.ticketHubModule.redrawIfOpen === 'function') {
                    window.ticketHubModule.redrawIfOpen();
                }
                const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
                if (typeof tm.awaitTicketsLoadForOrg === 'function' && orgId != null) {
                    await tm.awaitTicketsLoadForOrg(orgId);
                }
                // Reconcile with summary in the background; pin imports so parallel reloads cannot drop them.
                if (typeof tm.loadTicketsForCurrentOrg === 'function') {
                    void tm.loadTicketsForCurrentOrg({
                        forceRefresh: true,
                        preserveImportedTickets: result.tickets,
                    });
                }
            }

            // Hide spinner and show success
            const spinner = progress.querySelector('.spinner');
            if (spinner) {
                spinner.style.display = 'none';
            }
            
            // Close modal after a short delay
            setTimeout(() => {
                closeTicketImporter();
            }, 2000);
        } else if (result.errors.length > 0) {
            console.error('Ticket import errors:\n' + errorMessages);
            const first = result.errors[0];
            const detail =
                first && first.error
                    ? `${first.ticketNumber || 'ticket'}: ${first.error}`
                    : `${result.errors.length} error(s)`;
            log(
                result.errors.length === 1
                    ? `✗ Import failed — ${detail}`
                    : `✗ ${result.errors.length} error(s) — ${detail}`
            );
            const spinner = progress.querySelector('.spinner');
            if (spinner) {
                spinner.style.display = 'none';
            }
            const hasCorsError = result.errors.some((err) => err.error && err.error.includes('CORS_ERROR'));
            if (hasCorsError) {
                await appAlert(
                    'CORS Error: The NV API does not allow direct browser requests due to CORS policy.\n\nTo use this feature, you need to:\n1. Set up a proxy server, or\n2. Use a backend endpoint that fetches the data.\n\nThe ticket importer is designed to work with a backend API that handles the CORS issue.'
                );
            }
        } else {
            log('⚠️ No tickets were successfully imported.');
            const spinner = progress.querySelector('.spinner');
            if (spinner) {
                spinner.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Error importing tickets:', error);
        
        // Hide spinner
        const spinner = progress.querySelector('.spinner');
        if (spinner) {
            spinner.style.display = 'none';
        }
        
        const isCorsError = error.name === 'CORSError' || (error.message && error.message.includes('CORS_ERROR'));
        
        if (isCorsError) {
            log('? CORS Error: API requests are blocked by browser security policy.');
            await appAlert('CORS Error: The NV API does not allow direct browser requests due to CORS policy.\n\nTo use this feature, you need to:\n1. Set up a proxy server, or\n2. Use a backend endpoint that fetches the data.\n\nThe ticket importer is designed to work with a backend API that handles the CORS issue.');
        } else {
            log(`? Error: ${error.message || 'Unknown error'}`);
            await appAlert(`Error importing tickets: ${error.message || 'Unknown error'}`);
        }
    } finally {
        // Re-enable submit button
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Import Tickets';
        }
    }
}

