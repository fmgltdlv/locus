/**
 * Ticket Hub table column catalog (stored + derived) and per-user visibility prefs.
 */
(function (global) {
    'use strict';

    const DEFAULT_DESKTOP_IDS = ['ticket', 'jobName', 'address'];
    const NARROW_IDS = ['ticket'];
    const SOFT_CAP = 8;
    const DASH = function () {
        return (global.TICKET_HUB_TEXT && global.TICKET_HUB_TEXT.EM_DASH) || '—';
    };

    function esc(s) {
        if (typeof hubEscapeHtml === 'function') return hubEscapeHtml(s);
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    function pickField(ticket, fieldId, fallback) {
        if (typeof hubMappedField === 'function') {
            return hubMappedField(ticket, fieldId, fallback);
        }
        const dm = global.ticketHubDisplayMap;
        if (dm && typeof dm.pickTicketField === 'function') {
            const v = dm.pickTicketField(ticket, fieldId);
            if (v != null && String(v).trim() !== '') return v;
        }
        return fallback;
    }

    function formatAbsDate(value) {
        if (value == null || value === '') return '';
        if (typeof global.formatRecordedDate === 'function') {
            const s = global.formatRecordedDate(value, '');
            return s || '';
        }
        const d = new Date(value);
        return isNaN(d.getTime()) ? '' : d.toLocaleDateString();
    }

    function formatRelativeFromMs(ms, futureWord, pastWord) {
        if (ms == null || !Number.isFinite(Number(ms))) return '';
        const importer = global.ticketImporterModule;
        const diff =
            importer && typeof importer.getCalendarDaysUntilInstant === 'function'
                ? importer.getCalendarDaysUntilInstant(ms)
                : null;
        if (diff == null) return '';
        if (diff === 0) return 'Today';
        if (diff === 1) return futureWord + ' 1 day';
        if (diff > 1) return futureWord + ' ' + diff + ' days';
        if (diff === -1) return pastWord + ' 1 day ago';
        return pastWord + ' ' + Math.abs(diff) + ' days ago';
    }

    function hubStatusForColumn(ticket) {
        const tm = global.ticketsModule;
        if (tm && typeof tm.getTicketWorkflowStatusForMap === 'function') {
            return tm.getTicketWorkflowStatusForMap(ticket) || '';
        }
        return (ticket && (ticket.status || ticket.computedWorkflowStatus || ticket.workflowStatus)) || '';
    }

    function statusBadgeClass(status) {
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

    function statusLabel(status) {
        if (status == null || status === '') return 'Unknown';
        return typeof global.formatWorkflowStatusDisplay === 'function'
            ? global.formatWorkflowStatusDisplay(status)
            : String(status).replace(/_/g, ' ');
    }

    function assigneeNames(ticket) {
        let list = [];
        if (typeof global.getProjectAssigneesForTicket === 'function') {
            list = global.getProjectAssigneesForTicket(ticket) || [];
        } else if (global.ticketsModule && typeof global.ticketsModule.getTicketAssignedUsers === 'function') {
            list = global.ticketsModule.getTicketAssignedUsers(ticket) || [];
        }
        const names = list
            .map(function (a) {
                return a && (a.userName || a.full_name || a.username) ? String(a.userName || a.full_name || a.username).trim() : '';
            })
            .filter(Boolean);
        return names.join(', ');
    }

    function timeframeMs(ticket, fieldType) {
        if (typeof getHubTicketTimeframeCompareMs === 'function') {
            return getHubTicketTimeframeCompareMs(ticket, fieldType);
        }
        return null;
    }

    function cellText(text, title, extraClass) {
        const disp = text != null && String(text).trim() !== '' ? String(text).trim() : DASH();
        const tip = title != null && String(title).trim() !== '' ? String(title).trim() : disp;
        const cls = extraClass ? ' ' + extraClass : '';
        return (
            '<td class="ticket-hub-td-muted ticket-hub-td-ellipsis' +
            cls +
            '" title="' +
            esc(tip) +
            '">' +
            esc(disp) +
            '</td>'
        );
    }

    const CATALOG = [
        {
            id: 'ticket',
            kind: 'stored',
            label: 'Ticket',
            group: 'Ticket',
            locked: true,
            defaultOn: true,
            resizable: true,
            minPx: 80,
        },
        {
            id: 'jobName',
            kind: 'stored',
            label: 'Job name',
            group: 'Ticket',
            defaultOn: true,
            resizable: true,
            minPx: 64,
        },
        {
            id: 'address',
            kind: 'stored',
            label: 'Address',
            group: 'Ticket',
            defaultOn: true,
            desktopOnly: true,
            resizable: true,
            minPx: 80,
        },
        {
            id: 'status',
            kind: 'stored',
            label: 'Status',
            group: 'Ticket',
            resizable: true,
            minPx: 72,
        },
        {
            id: 'type',
            kind: 'stored',
            label: 'Type',
            group: 'Ticket',
            resizable: true,
            minPx: 72,
        },
        {
            id: 'workActivity',
            kind: 'stored',
            label: 'Work activity',
            group: 'Ticket',
            resizable: true,
            minPx: 80,
        },
        {
            id: 'lodgedDate',
            kind: 'stored',
            label: 'Submitted',
            group: 'Dates',
            resizable: true,
            minPx: 72,
        },
        {
            id: 'expirationDate',
            kind: 'stored',
            label: 'Expiration',
            group: 'Dates',
            resizable: true,
            minPx: 72,
        },
        {
            id: 'expiresIn',
            kind: 'derived',
            label: 'Expires in',
            group: 'Dates',
            resizable: true,
            minPx: 88,
        },
        {
            id: 'daysUntilLegalStart',
            kind: 'derived',
            label: 'Legal start',
            group: 'Dates',
            resizable: true,
            minPx: 80,
        },
        {
            id: 'ageSinceLodged',
            kind: 'derived',
            label: 'Age',
            group: 'Dates',
            resizable: true,
            minPx: 64,
        },
        {
            id: 'assignee',
            kind: 'stored',
            label: 'Assignee',
            group: 'People',
            resizable: true,
            minPx: 72,
        },
        {
            id: 'createdBy',
            kind: 'stored',
            label: 'Created by',
            group: 'People',
            resizable: true,
            minPx: 72,
        },
    ];

    const CATALOG_BY_ID = {};
    CATALOG.forEach(function (col) {
        CATALOG_BY_ID[col.id] = col;
    });

    function profileStorageKey() {
        let storageKey = 'userProfile';
        if (global.authModule && global.authModule.isAuthenticated && global.authModule.isAuthenticated()) {
            const user = global.authModule.getCurrentUser();
            if (user && user.id) storageKey = 'userProfile_user_' + user.id;
        }
        return storageKey;
    }

    function readProfile() {
        try {
            return JSON.parse(localStorage.getItem(profileStorageKey()) || '{}');
        } catch (_e) {
            return {};
        }
    }

    function writeProfile(patch) {
        try {
            const key = profileStorageKey();
            const profileData = readProfile();
            Object.keys(patch).forEach(function (k) {
                profileData[k] = patch[k];
            });
            localStorage.setItem(key, JSON.stringify(profileData));
            if (typeof global.schedulePersistUserUiPreferencesToServer === 'function') {
                global.schedulePersistUserUiPreferencesToServer();
            }
        } catch (e) {
            console.error(e);
        }
    }

    function sanitizeDesktopIds(ids) {
        const seen = {};
        const out = [];
        (ids || []).forEach(function (id) {
            if (!CATALOG_BY_ID[id] || seen[id]) return;
            seen[id] = true;
            out.push(id);
        });
        if (out.indexOf('ticket') < 0) out.unshift('ticket');
        else if (out[0] !== 'ticket') {
            out.splice(out.indexOf('ticket'), 1);
            out.unshift('ticket');
        }
        return out.length ? out : DEFAULT_DESKTOP_IDS.slice();
    }

    function loadDesktopColumnIds() {
        const saved = readProfile().ticketHubTableColumns;
        if (saved && Array.isArray(saved.desktop)) return sanitizeDesktopIds(saved.desktop);
        return DEFAULT_DESKTOP_IDS.slice();
    }

    function saveDesktopColumnIds(ids) {
        writeProfile({ ticketHubTableColumns: { desktop: sanitizeDesktopIds(ids) } });
    }

    function isNarrowTable() {
        return typeof isTicketHubMobile === 'function'
            ? isTicketHubMobile()
            : typeof global.innerWidth === 'number' && global.innerWidth <= 768;
    }

    /** Desktop hub is a fixed left sidebar; mobile uses a narrow table — identity stacks under ticket #. */
    function usesStackedTicketIdentityLayout() {
        return isNarrowTable() || (typeof global.innerWidth === 'number' && global.innerWidth >= 769);
    }

    function foldIdentityColumnsIntoTicket(ids) {
        if (!usesStackedTicketIdentityLayout() || !ids || !ids.length) return ids;
        if (ids.indexOf('ticket') < 0) return ids;
        const folded = ids.filter(function (id) {
            return id !== 'jobName' && id !== 'address';
        });
        return folded.length ? folded : ['ticket'];
    }

    function renderHubTicketIdentitySublineHtml(ticket) {
        const addrRaw = pickField(ticket, 'digSiteAddress', ticket && (ticket.address || ticket.locationSummary));
        const jobRaw = pickField(ticket, 'jobName', ticket && ticket.jobName);
        const address = addrRaw != null && String(addrRaw).trim() !== '' ? String(addrRaw).trim() : '';
        const jobName = jobRaw != null && String(jobRaw).trim() !== '' ? String(jobRaw).trim() : '';
        if (!address && !jobName) return '';
        const parts = [];
        if (address) parts.push('<span class="ticket-hub-ticket-subline-address">' + esc(address) + '</span>');
        if (address && jobName) parts.push('<span class="ticket-hub-ticket-subline-sep" aria-hidden="true">·</span>');
        if (jobName) parts.push('<span class="ticket-hub-ticket-subline-job">' + esc(jobName) + '</span>');
        const title = [address, jobName].filter(Boolean).join(' · ');
        return (
            '<div class="ticket-hub-ticket-subline" title="' +
            esc(title) +
            '">' +
            parts.join('') +
            '</div>'
        );
    }

    function visibleColumnIds() {
        if (isNarrowTable()) return NARROW_IDS.slice();
        return foldIdentityColumnsIntoTicket(loadDesktopColumnIds());
    }

    function getColumnLayout() {
        const ids = visibleColumnIds();
        const bulkOn =
            typeof hubBulkColumnEnabled === 'function' ? hubBulkColumnEnabled() : false;
        const cols = [];
        if (bulkOn) cols.push({ key: 'bulk', resizable: false, minPx: 0 });
        ids.forEach(function (id, i) {
            const def = CATALOG_BY_ID[id];
            if (!def) return;
            cols.push({
                key: id,
                resizable: def.resizable !== false,
                minPx: def.minPx || 64,
                handle: i < ids.length - 1,
            });
        });
        return cols;
    }

    function renderHeadHtml() {
        const ids = visibleColumnIds();
        const bulkOn = typeof hubBulkColumnEnabled === 'function' ? hubBulkColumnEnabled() : false;
        let html = '';
        if (bulkOn) {
            html +=
                '<th class="ticket-hub-th-bulk" scope="col" title="Select rows for bulk actions" data-hub-col-key="bulk">' +
                (typeof hubSelectAllCheckboxHtml === 'function' ? hubSelectAllCheckboxHtml() : '') +
                '</th>';
        }
        ids.forEach(function (id, i) {
            const def = CATALOG_BY_ID[id];
            if (!def) return;
            const last = i === ids.length - 1;
            const mobileLabel = id === 'ticket' && isNarrowTable() ? 'Ticket #' : def.label;
            html += hubTableHeadCell(mobileLabel, id, { handle: !last && def.resizable !== false });
        });
        return html;
    }

    function renderCellHtml(ticket, colId) {
        const def = CATALOG_BY_ID[colId];
        if (!def) return cellText('');
        if (colId === 'ticket') {
            const num =
                typeof formatTicketNumberCellHtml === 'function' ? formatTicketNumberCellHtml(ticket) : esc(ticket && ticket.ticketNumber);
            const spin = typeof hubTicketRowRefreshSpinnerHtml === 'function' ? hubTicketRowRefreshSpinnerHtml(ticket) : '';
            const stacked = usesStackedTicketIdentityLayout();
            const subline = stacked ? renderHubTicketIdentitySublineHtml(ticket) : '';
            const stackedCls = stacked ? ' ticket-hub-td-num--stacked' : '';
            return (
                '<td class="ticket-hub-td-num ticket-hub-td-num-rev' +
                stackedCls +
                '" data-hub-col-key="ticket">' +
                '<div class="ticket-hub-ticket-identity">' +
                num +
                spin +
                subline +
                '</div>' +
                '</td>'
            );
        }
        if (colId === 'jobName') {
            const raw = pickField(ticket, 'jobName', ticket && ticket.jobName);
            return cellText(raw).replace('<td ', '<td data-hub-col-key="jobName" ');
        }
        if (colId === 'address') {
            const raw = pickField(ticket, 'digSiteAddress', ticket && (ticket.address || ticket.locationSummary));
            return cellText(raw).replace('<td ', '<td data-hub-col-key="address" ');
        }
        if (colId === 'status') {
            const status = hubStatusForColumn(ticket);
            const label = statusLabel(status);
            const cls = statusBadgeClass(status);
            const wm = global.workflowAckModule;
            const mark =
                wm && typeof wm.preferCoreStatusIndicatorHtml === 'function'
                    ? wm.preferCoreStatusIndicatorHtml(
                          status,
                          '<span class="ticket-card-status ' + cls + '">' + esc(label) + '</span>'
                      )
                    : '<span class="ticket-card-status ' + cls + '">' + esc(label) + '</span>';
            return (
                '<td class="ticket-hub-td-status" data-hub-col-key="status" title="' +
                esc(label) +
                '">' +
                mark +
                '</td>'
            );
        }
        if (colId === 'type') {
            const dm = global.ticketHubDisplayMap;
            const raw =
                dm && typeof dm.formatTicketTypeWithUsanStatus === 'function'
                    ? dm.formatTicketTypeWithUsanStatus(ticket)
                    : pickField(ticket, 'providerTicketType');
            return cellText(raw).replace('<td ', '<td data-hub-col-key="type" ');
        }
        if (colId === 'workActivity') {
            return cellText(pickField(ticket, 'workActivity', ticket && ticket.workActivity)).replace(
                '<td ',
                '<td data-hub-col-key="workActivity" '
            );
        }
        if (colId === 'lodgedDate') {
            const raw = pickField(ticket, 'providerLodgedOn', ticket && (ticket.providerLodgedOn || ticket.createdAt));
            const abs = formatAbsDate(raw);
            return cellText(abs, abs).replace('<td ', '<td data-hub-col-key="lodgedDate" ');
        }
        if (colId === 'expirationDate') {
            const importer = global.ticketImporterModule;
            const raw =
                importer && typeof importer.getTicketExpirationDateForStatus === 'function'
                    ? importer.getTicketExpirationDateForStatus(ticket)
                    : ticket && ticket.endTime;
            const abs = formatAbsDate(raw);
            return cellText(abs, abs).replace('<td ', '<td data-hub-col-key="expirationDate" ');
        }
        if (colId === 'expiresIn') {
            const importer = global.ticketImporterModule;
            const info =
                importer && typeof importer.formatTicketExpiresInDisplay === 'function'
                    ? importer.formatTicketExpiresInDisplay(ticket)
                    : { text: '', title: '', tone: '' };
            const toneCls = info.tone ? ' ticket-hub-td-expires--' + info.tone : '';
            return cellText(info.text, info.title, toneCls.trim()).replace(
                '<td ',
                '<td data-hub-col-key="expiresIn" '
            );
        }
        if (colId === 'daysUntilLegalStart') {
            const ms = timeframeMs(ticket, 'legal_start');
            const text = formatRelativeFromMs(ms, 'In', 'Started');
            return cellText(text, formatAbsDate(ms)).replace('<td ', '<td data-hub-col-key="daysUntilLegalStart" ');
        }
        if (colId === 'ageSinceLodged') {
            const raw = pickField(ticket, 'providerLodgedOn', ticket && (ticket.providerLodgedOn || ticket.createdAt));
            const parsed =
                raw && typeof global.parseInstantForDisplay === 'function'
                    ? global.parseInstantForDisplay(raw)
                    : raw
                      ? new Date(raw)
                      : null;
            const ms = parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : NaN;
            const text = formatRelativeFromMs(ms, 'In', 'Lodged');
            return cellText(text, formatAbsDate(raw)).replace('<td ', '<td data-hub-col-key="ageSinceLodged" ');
        }
        if (colId === 'assignee') {
            return cellText(assigneeNames(ticket)).replace('<td ', '<td data-hub-col-key="assignee" ');
        }
        if (colId === 'createdBy') {
            return cellText(pickField(ticket, 'createdBy', ticket && ticket.createdBy)).replace(
                '<td ',
                '<td data-hub-col-key="createdBy" '
            );
        }
        return cellText('').replace('<td ', '<td data-hub-col-key="' + esc(colId) + '" ');
    }

    function pickerGroups() {
        const groups = [];
        const seen = {};
        CATALOG.forEach(function (col) {
            if (!seen[col.group]) {
                seen[col.group] = true;
                groups.push(col.group);
            }
        });
        return groups;
    }

    function setColumnEnabled(id, on) {
        const def = CATALOG_BY_ID[id];
        if (!def || def.locked) return loadDesktopColumnIds();
        const ids = loadDesktopColumnIds();
        const idx = ids.indexOf(id);
        if (on && idx < 0) {
            const catalogOrder = CATALOG.map(function (c) {
                return c.id;
            });
            ids.push(id);
            ids.sort(function (a, b) {
                return catalogOrder.indexOf(a) - catalogOrder.indexOf(b);
            });
        } else if (!on && idx >= 0) {
            ids.splice(idx, 1);
        }
        const next = sanitizeDesktopIds(ids);
        saveDesktopColumnIds(next);
        return next;
    }

    function dataColumnCount(ids) {
        return (ids || []).filter(function (id) {
            return id !== 'bulk';
        }).length;
    }

    function resetDesktopColumns() {
        saveDesktopColumnIds(DEFAULT_DESKTOP_IDS.slice());
        return loadDesktopColumnIds();
    }

    function closeColumnPicker() {
        const pop = document.getElementById('ticketHubColumnsPopover');
        const btn = document.getElementById('ticketHubColumnsBtn');
        if (pop) pop.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function renderColumnPickerBody(pop) {
        if (!pop) return;
        const prevBody = pop.querySelector('.ticket-hub-columns-popover-body');
        const scrollTop = prevBody ? prevBody.scrollTop : 0;
        const enabledIds = loadDesktopColumnIds();
        const enabled = {};
        enabledIds.forEach(function (id) {
            enabled[id] = true;
        });
        const count = dataColumnCount(enabledIds);
        const total = CATALOG.filter(function (col) {
            return !col.locked;
        }).length;
        let html =
            '<div class="ticket-hub-columns-popover-header">' +
            '<div>' +
            '<p class="ticket-hub-columns-popover-title">Table columns</p>' +
            '<p class="ticket-hub-columns-popover-subtitle">' +
            esc(String(count)) +
            ' of ' +
            esc(String(total)) +
            ' visible</p>' +
            '</div>' +
            '<button type="button" class="ticket-hub-columns-popover-close" data-hub-col-close aria-label="Close column picker">&times;</button>' +
            '</div>' +
            '<div class="ticket-hub-columns-popover-body app-overlay-scroll">';
        pickerGroups().forEach(function (group) {
            html += '<div class="ticket-hub-columns-popover-group">';
            html += '<div class="ticket-hub-columns-popover-group-label">' + esc(group) + '</div>';
            html += '<div class="ticket-hub-columns-popover-grid">';
            CATALOG.forEach(function (col) {
                if (col.group !== group) return;
                const checked = enabled[col.id] ? ' checked' : '';
                const disabled = col.locked ? ' disabled' : '';
                const lockedCls = col.locked ? ' ticket-hub-columns-popover-row--locked' : '';
                html +=
                    '<label class="ticket-hub-columns-popover-row' +
                    lockedCls +
                    '">' +
                    '<input type="checkbox" data-hub-col-toggle="' +
                    esc(col.id) +
                    '"' +
                    checked +
                    disabled +
                    ' />' +
                    '<span>' +
                    esc(col.label) +
                    (col.kind === 'derived' ? ' (computed)' : '') +
                    '</span></label>';
            });
            html += '</div></div>';
        });
        if (count >= SOFT_CAP) {
            html +=
                '<p class="ticket-hub-columns-popover-warn" data-hub-col-warn>Lots of columns can squeeze the list on smaller laptops.</p>';
        }
        html +=
            '</div>' +
            '<div class="ticket-hub-columns-popover-footer">' +
            '<button type="button" class="ticket-hub-columns-popover-reset" data-hub-col-reset>Reset to default</button>' +
            '</div>';
        pop.innerHTML = html;
        if (scrollTop) {
            const nextBody = pop.querySelector('.ticket-hub-columns-popover-body');
            if (nextBody) nextBody.scrollTop = scrollTop;
        }
    }

    function ensureColumnPicker() {
        let pop = document.getElementById('ticketHubColumnsPopover');
        if (pop) return pop;
        const anchor =
            document.querySelector('#ticketHubWindow .ticket-hub-columns-anchor') ||
            document.querySelector('#ticketHubWindow .ticket-hub-toolbar');
        if (!anchor) return null;
        pop = document.createElement('div');
        pop.id = 'ticketHubColumnsPopover';
        pop.className = 'ticket-hub-columns-popover';
        pop.hidden = true;
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', 'Table columns');
        anchor.appendChild(pop);
        pop.addEventListener('click', function (e) {
            e.stopPropagation();
            if (e.target.closest && e.target.closest('[data-hub-col-close]')) {
                closeColumnPicker();
                return;
            }
            const resetBtn = e.target.closest ? e.target.closest('[data-hub-col-reset]') : null;
            if (resetBtn) {
                resetDesktopColumns();
                if (typeof global.renderHubTable === 'function') global.renderHubTable();
                renderColumnPickerBody(pop);
            }
        });
        pop.addEventListener('change', function (e) {
            const input = e.target && e.target.closest ? e.target.closest('[data-hub-col-toggle]') : null;
            if (!input) return;
            const id = input.getAttribute('data-hub-col-toggle');
            setColumnEnabled(id, input.checked);
            if (typeof global.renderHubTable === 'function') global.renderHubTable();
            renderColumnPickerBody(pop);
            const nextCount = dataColumnCount(loadDesktopColumnIds());
            if (input.checked && nextCount >= SOFT_CAP && typeof global.appAlert === 'function') {
                /* warn in-popover only; already rendered */
            }
        });
        return pop;
    }

    function toggleColumnPicker() {
        if (isNarrowTable()) return;
        const btn = document.getElementById('ticketHubColumnsBtn');
        const pop = ensureColumnPicker();
        if (!btn || !pop) return;
        const open = pop.hidden;
        if (open) {
            renderColumnPickerBody(pop);
            pop.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
        } else {
            closeColumnPicker();
        }
    }

    function initHubColumnPicker() {
        const btn = document.getElementById('ticketHubColumnsBtn');
        if (!btn || btn.dataset.hubColumnsInit === '1') return;
        btn.dataset.hubColumnsInit = '1';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            toggleColumnPicker();
        });
        document.addEventListener('click', function (e) {
            const pop = document.getElementById('ticketHubColumnsPopover');
            if (!pop || pop.hidden) return;
            if (e.target.closest && (e.target.closest('#ticketHubColumnsPopover') || e.target.closest('#ticketHubColumnsBtn'))) {
                return;
            }
            closeColumnPicker();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeColumnPicker();
        });
        scheduleExpiresInMidnightRefresh();
    }

    let expiresMidnightTimer = null;
    function scheduleExpiresInMidnightRefresh() {
        if (expiresMidnightTimer) clearTimeout(expiresMidnightTimer);
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
        expiresMidnightTimer = setTimeout(function () {
            if (typeof global.renderHubTable === 'function') {
                const win = document.getElementById('ticketHubWindow');
                if (win && win.classList.contains('show')) global.renderHubTable();
            }
            scheduleExpiresInMidnightRefresh();
        }, Math.max(1000, next.getTime() - now.getTime()));
    }

    global.ticketHubColumnRegistry = {
        CATALOG: CATALOG,
        DEFAULT_DESKTOP_IDS: DEFAULT_DESKTOP_IDS,
        loadDesktopColumnIds: loadDesktopColumnIds,
        saveDesktopColumnIds: saveDesktopColumnIds,
        visibleColumnIds: visibleColumnIds,
        getColumnLayout: getColumnLayout,
        renderHeadHtml: renderHeadHtml,
        renderCellHtml: renderCellHtml,
        renderHubTicketIdentitySublineHtml: renderHubTicketIdentitySublineHtml,
        setColumnEnabled: setColumnEnabled,
        pickerGroups: pickerGroups,
        dataColumnCount: dataColumnCount,
        SOFT_CAP: SOFT_CAP,
        isNarrowTable: isNarrowTable,
        initPicker: initHubColumnPicker,
        closePicker: closeColumnPicker,
    };
})(typeof window !== 'undefined' ? window : globalThis);
