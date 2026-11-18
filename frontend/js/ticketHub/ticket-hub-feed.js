/**
 * Feed-mode Ticket Hub: service_requests queue, per-org Ready/Not ready stats,
 * Scan maps + Acknowledge. Hides create/import/compliance chrome.
 */
(function () {
    'use strict';

    let feedRows = [];
    let feedStatsByOrg = {};
    let feedOrgFilter = new Set();
    let feedTicketStatusFilter = new Set();
    let feedSelectedIds = new Set();
    let feedLoadInFlight = false;

    function isFeedMode() {
        return !!(
            window.orgSelectorModule &&
            typeof window.orgSelectorModule.canUseCurrentDevTicketHub === 'function' &&
            window.orgSelectorModule.canUseCurrentDevTicketHub()
        );
    }

    function escapeHtml(s) {
        if (s == null || s === '') return '';
        const d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    function apiBase() {
        return (window.authModule && window.authModule.API_BASE) || window.API_BASE || '';
    }

    function currentOrgId() {
        if (window.orgSelectorModule && typeof window.orgSelectorModule.getCurrentOrgId === 'function') {
            return window.orgSelectorModule.getCurrentOrgId();
        }
        return null;
    }

    function applyFeedHubChrome(active) {
        const win = document.getElementById('ticketHubWindow');
        if (win) win.classList.toggle('ticket-hub--feed-mode', !!active);

        const title = document.getElementById('ticketHubWindowTitle');
        if (title) title.textContent = active ? 'Documentation feed' : 'Tickets';

        const hideIds = [
            'ticketHubCreateTicketBtn',
            'ticketHubCreateProjectBtn',
            'ticketHubImportBtn',
            'ticketHubBulkRenewBtn',
            'ticketHubBulkDeleteBtn',
            'ticketHubBulkRequestServicesBtn',
        ];
        hideIds.forEach(function (id) {
            const el = document.getElementById(id);
            if (el) el.style.display = active ? 'none' : '';
        });

        const sectionTabs = document.querySelectorAll(
            '[data-ticket-hub-section="compliance"], [data-ticket-hub-section="analytics"]'
        );
        sectionTabs.forEach(function (el) {
            el.style.display = active ? 'none' : '';
        });

        ensureFeedToolbar(active);
    }

    function ensureFeedToolbar(active) {
        let bar = document.getElementById('ticketHubFeedToolbar');
        if (!active) {
            if (bar) bar.style.display = 'none';
            return;
        }
        if (!bar) {
            const stats = document.getElementById('ticketHubStats');
            bar = document.createElement('div');
            bar.id = 'ticketHubFeedToolbar';
            bar.className = 'ticket-hub-feed-toolbar';
            bar.innerHTML =
                '<div class="ticket-hub-feed-toolbar-actions">' +
                '<button type="button" class="ticket-hub-action-btn" id="ticketHubFeedScanBtn">Scan maps</button>' +
                '<button type="button" class="ticket-hub-action-btn ticket-hub-action-secondary" id="ticketHubFeedAckBtn">Acknowledge</button>' +
                '<button type="button" class="ticket-hub-action-btn ticket-hub-action-secondary" id="ticketHubFeedRefreshBtn">Refresh</button>' +
                '</div>' +
                '<div id="ticketHubFeedOrgFilter" class="ticket-hub-feed-org-filter"></div>';
            if (stats && stats.parentNode) {
                stats.parentNode.insertBefore(bar, stats.nextSibling);
            } else {
                const win = document.getElementById('ticketHubWindow');
                if (win) win.appendChild(bar);
            }
            const scanBtn = document.getElementById('ticketHubFeedScanBtn');
            const ackBtn = document.getElementById('ticketHubFeedAckBtn');
            const refreshBtn = document.getElementById('ticketHubFeedRefreshBtn');
            if (scanBtn) scanBtn.addEventListener('click', function () { void feedScanMaps(); });
            if (ackBtn) ackBtn.addEventListener('click', function () { void feedAcknowledgeSelected(); });
            if (refreshBtn) refreshBtn.addEventListener('click', function () { void loadFeedHubQueue(true); });
        }
        bar.style.display = '';
    }

    function statusBadgeHtml(status) {
        const s = String(status || '').toUpperCase();
        const cls = s === 'READY' ? 'ready' : s === 'NOT_READY' ? 'not-ready' : 'expired';
        const label = s === 'READY' ? 'Ready' : s === 'NOT_READY' ? 'Not ready' : '—';
        const fallback = '<span class="ticket-card-status ' + cls + '">' + escapeHtml(label) + '</span>';
        const wm = window.workflowAckModule;
        if (wm && typeof wm.preferCoreStatusIndicatorHtml === 'function') {
            return wm.preferCoreStatusIndicatorHtml(s, fallback);
        }
        return fallback;
    }

    function srStatusLabel(status) {
        const s = String(status || '').toLowerCase();
        if (s === 'complete') return 'Map covered';
        if (s === 'incomplete' || s === 'new') return 'Needs map';
        if (s === 'acknowledged') return 'Acknowledged';
        return s || '—';
    }

    function filteredFeedRows() {
        return feedRows.filter(function (row) {
            if (feedOrgFilter.size > 0 && !feedOrgFilter.has(String(row.organizationId))) {
                return false;
            }
            if (feedTicketStatusFilter.size > 0) {
                const st = String(row.feedTicketStatus || '').toUpperCase();
                if (!feedTicketStatusFilter.has(st)) return false;
            }
            return true;
        });
    }

    function renderFeedStats() {
        const statsEl = document.getElementById('ticketHubStats');
        if (!statsEl) return;
        const keys = Object.keys(feedStatsByOrg || {});
        if (!keys.length) {
            statsEl.innerHTML = '<div class="ticket-hub-td-muted">No active feed items</div>';
            return;
        }
        statsEl.innerHTML = keys
            .map(function (orgId) {
                const s = feedStatsByOrg[orgId] || { ready: 0, notReady: 0 };
                const name = s.organizationName || ('Org ' + orgId);
                const orgActive = feedOrgFilter.has(String(orgId));
                return (
                    '<div class="ticket-hub-feed-org-stats" data-feed-org="' +
                    escapeHtml(orgId) +
                    '">' +
                    '<div class="ticket-hub-feed-org-name">' +
                    escapeHtml(name) +
                    '</div>' +
                    '<button type="button" class="ticket-hub-stat-card' +
                    (orgActive && feedTicketStatusFilter.has('READY') ? ' ticket-hub-stat-card-active' : '') +
                    '" data-feed-stat="READY" data-feed-org="' +
                    escapeHtml(orgId) +
                    '"><span class="ticket-hub-stat-label">Ready</span><span class="ticket-hub-stat-value">' +
                    Number(s.ready || 0) +
                    '</span></button>' +
                    '<button type="button" class="ticket-hub-stat-card' +
                    (orgActive && feedTicketStatusFilter.has('NOT_READY') ? ' ticket-hub-stat-card-active' : '') +
                    '" data-feed-stat="NOT_READY" data-feed-org="' +
                    escapeHtml(orgId) +
                    '"><span class="ticket-hub-stat-label">Not ready</span><span class="ticket-hub-stat-value">' +
                    Number(s.notReady || 0) +
                    '</span></button>' +
                    '</div>'
                );
            })
            .join('');

        statsEl.querySelectorAll('[data-feed-stat]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const orgId = String(btn.getAttribute('data-feed-org') || '');
                const stat = String(btn.getAttribute('data-feed-stat') || '');
                feedOrgFilter = new Set([orgId]);
                feedTicketStatusFilter = new Set([stat]);
                renderFeedHubTable();
                renderFeedStats();
            });
        });
    }

    function renderFeedHubTable() {
        const head = document.getElementById('ticketHubTableHeadRow');
        const body = document.getElementById('ticketHubTableBody');
        const empty = document.getElementById('ticketHubTableEmpty');
        if (!head || !body) return;

        head.innerHTML =
            '<th style="width:2rem"></th>' +
            '<th>Org</th><th>Ticket</th><th>Service</th><th>SR status</th><th>Ticket status</th><th>Created</th>';

        const rows = filteredFeedRows();
        if (!rows.length) {
            body.innerHTML = '';
            if (empty) {
                empty.style.display = '';
                empty.textContent = 'No feed items match your filters.';
            }
            return;
        }
        if (empty) empty.style.display = 'none';

        body.innerHTML = rows
            .map(function (row) {
                const id = Number(row.id);
                const checked = feedSelectedIds.has(id) ? ' checked' : '';
                const ticketNo =
                    (row.ticketSummary && row.ticketSummary.ticketNumber) ||
                    (row.feed && row.feed.ticketNumber) ||
                    '—';
                return (
                    '<tr data-feed-sr-id="' +
                    id +
                    '">' +
                    '<td><input type="checkbox" class="ticket-hub-feed-select" data-id="' +
                    id +
                    '"' +
                    checked +
                    ' /></td>' +
                    '<td>' +
                    escapeHtml(row.organizationName || '—') +
                    '</td>' +
                    '<td>' +
                    escapeHtml(ticketNo) +
                    '</td>' +
                    '<td>' +
                    escapeHtml(row.serviceRequested || row.serviceType || '—') +
                    '</td>' +
                    '<td>' +
                    escapeHtml(srStatusLabel(row.status)) +
                    '</td>' +
                    '<td>' +
                    statusBadgeHtml(row.feedTicketStatus) +
                    '</td>' +
                    '<td>' +
                    escapeHtml(formatFeedPosrWhen(row.createdAt)) +
                    '</td>' +
                    '</tr>'
                );
            })
            .join('');

        body.querySelectorAll('.ticket-hub-feed-select').forEach(function (cb) {
            cb.addEventListener('change', function () {
                const id = Number(cb.getAttribute('data-id'));
                if (cb.checked) feedSelectedIds.add(id);
                else feedSelectedIds.delete(id);
            });
        });

        body.querySelectorAll('tr[data-feed-sr-id]').forEach(function (tr) {
            tr.addEventListener('click', function (ev) {
                if (ev.target && ev.target.closest && ev.target.closest('input')) return;
                const id = Number(tr.getAttribute('data-feed-sr-id'));
                const row = feedRows.find(function (r) {
                    return Number(r.id) === id;
                });
                if (row) openFeedTicketDetail(row);
            });
        });
    }

    function formatFeedPosrWhen(raw) {
        if (raw == null || raw === '') return '—';
        if (typeof window.formatRecordedDateTime === 'function') {
            return window.formatRecordedDateTime(raw, '—', String(raw));
        }
        try {
            const d = new Date(raw);
            if (!Number.isNaN(d.getTime())) return d.toLocaleString();
        } catch (_e) {
            /* ignore */
        }
        return String(raw);
    }

    function feedPosrRowsFromParsed(parsed) {
        const history = Array.isArray(parsed && parsed.history) ? parsed.history.slice() : [];
        if (history.length) {
            history.sort(function (a, b) {
                const ta = Date.parse(a && a.respondedAt) || 0;
                const tb = Date.parse(b && b.respondedAt) || 0;
                return tb - ta;
            });
            return history.slice(0, 50).map(function (h) {
                return {
                    when: h.respondedAt,
                    station: h.operatorCode || '',
                    name: h.operatorName || '',
                    code: h.statusCode || '',
                    comment: h.comment || '',
                };
            });
        }
        const stations = Array.isArray(parsed && parsed.stationDetails) ? parsed.stationDetails : [];
        return stations.map(function (s) {
            return {
                when: s.responseDate,
                station: s.code || '',
                name: s.name || '',
                code: s.responseCode || s.status || '',
                comment: s.comment || '',
            };
        });
    }

    async function fetchLivePosrByTicketNumber(ticketNumber) {
        const tn = String(ticketNumber || '').trim();
        if (!tn || !window.authModule || typeof window.authModule.apiRequest !== 'function') {
            throw new Error('Not authenticated');
        }
        const tryNumbers = [tn];
        const base =
            window.ticketImporterModule && typeof window.ticketImporterModule.normalizeTicketBase === 'function'
                ? window.ticketImporterModule.normalizeTicketBase(tn)
                : tn.includes('-')
                  ? tn.split('-')[0].trim()
                  : tn;
        if (base && base !== tn) tryNumbers.push(base);

        let lastErr = null;
        for (let i = 0; i < tryNumbers.length; i += 1) {
            try {
                const data = await window.authModule.apiRequest(
                    'tickets/' + encodeURIComponent(tryNumbers[i])
                );
                if (
                    window.ticketImporterModule &&
                    typeof window.ticketImporterModule.parsePosrData === 'function'
                ) {
                    return window.ticketImporterModule.parsePosrData(data);
                }
                const posrTicket = (data && data.posrTicket) || {};
                return {
                    ticketNumber: posrTicket.ticketNumber || tryNumbers[i],
                    history: [],
                    stationDetails: Array.isArray(posrTicket.stations) ? posrTicket.stations : [],
                };
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error('POSR lookup failed');
    }

    function renderFeedPosrDetailPanel(opts) {
        const panel = document.getElementById('ticketHubDetail');
        if (!panel) return;
        const options = opts || {};
        if (typeof window.hideTicketPopupKeepSelection === 'function') {
            window.hideTicketPopupKeepSelection();
        }
        if (options.loading) {
            panel.innerHTML =
                '<div class="ticket-hub-detail-body-wrap ticket-hub-feed-posr-detail">' +
                '<div class="ticket-hub-detail-empty" aria-busy="true">Loading POSR responses…</div>' +
                '</div>';
            return;
        }
        if (options.error) {
            panel.innerHTML =
                '<div class="ticket-hub-detail-body-wrap ticket-hub-feed-posr-detail">' +
                '<div class="ticket-hub-detail-empty">' +
                escapeHtml(options.error) +
                '</div></div>';
            return;
        }

        const ticketNumber = options.ticketNumber || '—';
        const orgName = options.organizationName || '—';
        const rows = Array.isArray(options.rows) ? options.rows : [];
        const rowsHtml = rows.length
            ? rows
                  .map(function (r) {
                      return (
                          '<tr>' +
                          '<td>' +
                          escapeHtml(formatFeedPosrWhen(r.when)) +
                          '</td>' +
                          '<td>' +
                          escapeHtml(r.station || '—') +
                          '</td>' +
                          '<td>' +
                          escapeHtml(r.name || '—') +
                          '</td>' +
                          '<td>' +
                          escapeHtml(r.code || '—') +
                          '</td>' +
                          '<td>' +
                          escapeHtml(r.comment || '—') +
                          '</td>' +
                          '</tr>'
                      );
                  })
                  .join('')
            : '<tr><td colspan="5" class="ticket-hub-td-muted">No public responses found for this ticket.</td></tr>';

        panel.innerHTML =
            '<div class="ticket-hub-detail-body-wrap ticket-hub-feed-posr-detail" data-feed-posr-ticket="' +
            escapeHtml(ticketNumber) +
            '">' +
            '<div class="ticket-hub-feed-posr-header">' +
            '<div class="ticket-hub-feed-posr-title">Ticket ' +
            escapeHtml(ticketNumber) +
            '</div>' +
            '<div class="ticket-hub-td-muted">' +
            escapeHtml(orgName) +
            ' · Live POSR responses</div>' +
            '</div>' +
            '<div class="ticket-hub-responses-scroll ticket-responses-table-wrap">' +
            '<table class="ticket-responses-table ticket-hub-feed-posr-table">' +
            '<thead><tr>' +
            '<th>When</th><th>Station</th><th>Utility</th><th>Code</th><th>Comment</th>' +
            '</tr></thead>' +
            '<tbody>' +
            rowsHtml +
            '</tbody></table></div></div>';
    }

    async function openFeedTicketDetail(row) {
        const ticketNumber =
            (row.ticketSummary && row.ticketSummary.ticketNumber) ||
            (row.feed && row.feed.ticketNumber);
        if (!ticketNumber || !window.authModule) return;

        window.__feedHubReadOnlyCompliance = true;
        window.__FEED_HUB_DETAIL_TICKET = null;
        renderFeedPosrDetailPanel({ loading: true });

        try {
            const parsed = await fetchLivePosrByTicketNumber(ticketNumber);
            const rows = feedPosrRowsFromParsed(parsed);
            renderFeedPosrDetailPanel({
                ticketNumber: (parsed && parsed.ticketNumber) || ticketNumber,
                organizationName: row.organizationName || '',
                rows: rows,
            });
        } catch (e) {
            console.warn('openFeedTicketDetail POSR:', e);
            renderFeedPosrDetailPanel({
                error:
                    'Could not load POSR responses for ' +
                    String(ticketNumber) +
                    ': ' +
                    (e && e.message ? e.message : 'error'),
            });
        }
    }

    async function loadFeedHubQueue(force) {
        if (!isFeedMode()) return;
        if (feedLoadInFlight && !force) return;
        const orgId = currentOrgId();
        if (!orgId || !window.authModule) return;
        feedLoadInFlight = true;
        try {
            const data = await window.authModule.apiRequest(
                apiBase() + '/feed/service-requests?organizationId=' + encodeURIComponent(String(orgId))
            );
            feedRows = (data && data.serviceRequests) || [];
            feedStatsByOrg = (data && data.feedStatsByOrg) || {};
            renderFeedStats();
            renderFeedHubTable();
            if (typeof window.loadFeedMapMarkers === 'function') {
                void window.loadFeedMapMarkers();
            }
            if (typeof window.refreshFeedOpenCount === 'function') {
                void window.refreshFeedOpenCount();
            }
        } catch (e) {
            console.error('loadFeedHubQueue:', e);
            const body = document.getElementById('ticketHubTableBody');
            if (body) body.innerHTML = '';
            const empty = document.getElementById('ticketHubTableEmpty');
            if (empty) {
                empty.style.display = '';
                empty.textContent = 'Failed to load feed queue.';
            }
        } finally {
            feedLoadInFlight = false;
        }
    }

    async function feedScanMaps() {
        const orgId = currentOrgId();
        if (!orgId || !window.authModule) return;
        const ids = Array.from(feedSelectedIds);
        const body = {};
        if (ids.length) body.serviceRequestIds = ids;
        if (feedOrgFilter.size === 1) {
            body.organizationIds = Array.from(feedOrgFilter).map(Number);
        }
        try {
            const result = await window.authModule.apiRequest(
                apiBase() + '/feed/scan-maps?organizationId=' + encodeURIComponent(String(orgId)),
                { method: 'POST', body: JSON.stringify(body) }
            );
            const msg =
                'Scanned ' +
                (result && result.scanned != null ? result.scanned : 0) +
                '; updated to map covered: ' +
                (result && result.updatedToComplete != null ? result.updatedToComplete : 0);
            if (typeof window.showToast === 'function') window.showToast(msg, 'success');
            else if (typeof window.appAlert === 'function') await window.appAlert(msg);
            await loadFeedHubQueue(true);
        } catch (e) {
            if (typeof window.appAlert === 'function') {
                await window.appAlert('Scan maps failed: ' + (e.message || 'error'));
            }
        }
    }

    async function feedAcknowledgeSelected() {
        const orgId = currentOrgId();
        const ids = Array.from(feedSelectedIds);
        if (!ids.length) {
            if (typeof window.appAlert === 'function') {
                await window.appAlert('Select one or more feed items to acknowledge.');
            }
            return;
        }
        if (!orgId || !window.authModule) return;
        try {
            await window.authModule.apiRequest(
                apiBase() +
                    '/feed/service-requests/acknowledge?organizationId=' +
                    encodeURIComponent(String(orgId)),
                { method: 'PATCH', body: JSON.stringify({ ids: ids }) }
            );
            feedSelectedIds.clear();
            await loadFeedHubQueue(true);
        } catch (e) {
            if (typeof window.appAlert === 'function') {
                await window.appAlert('Acknowledge failed: ' + (e.message || 'error'));
            }
        }
    }

    async function enterFeedHubMode() {
        if (!isFeedMode()) {
            applyFeedHubChrome(false);
            window.__feedHubReadOnlyCompliance = false;
            return false;
        }
        applyFeedHubChrome(true);
        feedOrgFilter = new Set();
        feedTicketStatusFilter = new Set();
        feedSelectedIds.clear();
        // Clear previous org ticket-count HTML immediately so it cannot linger during fetch.
        const statsEl = document.getElementById('ticketHubStats');
        if (statsEl) {
            statsEl.hidden = false;
            statsEl.removeAttribute('aria-hidden');
            statsEl.classList.remove('ticket-hub-stats--collapsed');
            statsEl.innerHTML = '<div class="ticket-hub-td-muted">Loading feed stats…</div>';
        }
        await loadFeedHubQueue(true);
        return true;
    }

    function exitFeedHubMode() {
        applyFeedHubChrome(false);
        window.__feedHubReadOnlyCompliance = false;
        window.__FEED_HUB_DETAIL_TICKET = null;
    }

    window.ticketHubFeedModule = {
        isFeedMode,
        enterFeedHubMode,
        exitFeedHubMode,
        loadFeedHubQueue,
        renderFeedStats,
        feedScanMaps,
        feedAcknowledgeSelected,
    };
    window.enterFeedHubMode = enterFeedHubMode;
    window.exitFeedHubMode = exitFeedHubMode;
    window.isTicketHubFeedMode = isFeedMode;
})();
