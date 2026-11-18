(function () {
    'use strict';

    function normalizeTicketBase(ticketNumber) {
        return String(ticketNumber || '').split('-')[0];
    }

    function firstNonEmptyString() {
        for (let i = 0; i < arguments.length; i += 1) {
            const v = arguments[i];
            if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        return null;
    }

    /** Prefer POSR locale strings (M/D/YYYY …); fall back to local display for ISO/UTC. */
    function formatShareDateTime(value) {
        if (value == null || value === '') return '—';
        const s = String(value).trim();
        if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) return s;
        if (typeof window.formatRecordedDateTime === 'function') {
            return window.formatRecordedDateTime(s);
        }
        return s;
    }

    function parsePosrForShareDetail(data) {
        if (!data || typeof data !== 'object') return null;
        const posrTicket = data.posrTicket || {};
        const stations = Array.isArray(posrTicket.stations) ? posrTicket.stations : [];

        const startTime = firstNonEmptyString(data.jobStartDate, data.JobStartDate);
        const ticketExpirationDate = firstNonEmptyString(
            data.workExpirationDate,
            data.WorkExpirationDate,
            data.workExpiration_date
        );

        const workType = firstNonEmptyString(posrTicket.workType, posrTicket.WorkType, data.workType, data.WorkType);
        const workActivity = firstNonEmptyString(
            posrTicket.workActivity,
            posrTicket.WorkActivity,
            posrTicket.work_activity
        );
        const address = firstNonEmptyString(posrTicket.address, posrTicket.Address, posrTicket.locationSummary);
        const scopeOfWork = firstNonEmptyString(
            posrTicket.additionalRemarks,
            posrTicket.AdditionalRemarks,
            posrTicket.additional_remarks
        );
        let workflowStatus = firstNonEmptyString(posrTicket.jobStatus, posrTicket.JobStatus, posrTicket.ticketType, posrTicket.TicketType);
        if (!workflowStatus && posrTicket.isCancelled === true) workflowStatus = 'Cancelled';

        const operatorResponses = stations
            .filter((s) => s && (s.code || s.Code || s.name || s.Name))
            .map((s) => {
                const code = firstNonEmptyString(s.code, s.Code, s.stationCode, s.StationCode);
                const respondedAt = firstNonEmptyString(
                    s.responseDateString,
                    s.ResponseDateString,
                    s.responseDate,
                    s.ResponseDate,
                    s.respondedAt,
                    s.RespondedAt
                );
                const statusCode = firstNonEmptyString(s.responseCode, s.ResponseCode, s.status, s.Status);
                const responseDescription =
                    firstNonEmptyString(s.responseDescription, s.ResponseDescription) || '';
                const statusMod = window.shareOperatorResponseStatus;
                const operatorStatus =
                    statusMod && typeof statusMod.getOperatorStatus === 'function'
                        ? statusMod.getOperatorStatus(statusCode)
                        : statusCode
                          ? String(statusCode)
                          : 'READY';
                return {
                    stationCode: code,
                    operatorCode: code,
                    operatorName: firstNonEmptyString(s.name, s.Name, s.operatorName, s.OperatorName),
                    statusCode,
                    operatorStatus,
                    responseDescription,
                    respondedAt,
                    comment: firstNonEmptyString(s.comment, s.Comment, s.notes, s.Notes) || '',
                };
            });

        return {
            address,
            fullAddress: address,
            workDescription: workActivity || workType || undefined,
            scopeOfWork: scopeOfWork || undefined,
            categoryOfWork: workType || undefined,
            workflowStatus: workflowStatus || undefined,
            startTime: startTime || undefined,
            ticketExpirationDate: ticketExpirationDate || undefined,
            operatorResponses,
        };
    }

    function mergeShareTicketWithNvPosr(localTicket, nvTicket) {
        const out = Object.assign({}, localTicket || {});
        if (!nvTicket) return out;

        function preferNv(field, nvVal, localVal) {
            if (nvVal == null || nvVal === '') return localVal;
            if (field === 'startTime' || field === 'ticketExpirationDate') {
                if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(String(nvVal))) return nvVal;
                if (/T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/i.test(String(localVal || ''))) return nvVal;
            }
            return nvVal;
        }

        out.address = preferNv('address', nvTicket.address, out.address || out.fullAddress);
        out.fullAddress = preferNv('fullAddress', nvTicket.fullAddress || nvTicket.address, out.fullAddress);
        out.workDescription = preferNv('workDescription', nvTicket.workDescription, out.workDescription);
        out.scopeOfWork = preferNv('scopeOfWork', nvTicket.scopeOfWork, out.scopeOfWork);
        out.categoryOfWork = preferNv('categoryOfWork', nvTicket.categoryOfWork, out.categoryOfWork);
        out.workflowStatus = preferNv('workflowStatus', nvTicket.workflowStatus, out.workflowStatus);
        out.startTime = preferNv('startTime', nvTicket.startTime, out.startTime);
        out.ticketExpirationDate = preferNv(
            'ticketExpirationDate',
            nvTicket.ticketExpirationDate,
            out.ticketExpirationDate
        );
        if (Array.isArray(nvTicket.operatorResponses) && nvTicket.operatorResponses.length > 0) {
            out.operatorResponses = nvTicket.operatorResponses;
        }
        out.nvPosrLive = true;
        return out;
    }

    async function fetchNvPosrViaShare(apiBase, shareToken, ticketNumber) {
        const base = normalizeTicketBase(ticketNumber);
        const tn = encodeURIComponent(String(ticketNumber || '').trim());
        const res = await fetch(`${apiBase}/public/project-share/${shareToken}/nv-posr/${tn}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = (data && data.error) || `Nevada 811 lookup failed (${res.status})`;
            throw new Error(msg);
        }
        if (data && data.posrTicket) return data;
        if (base && base !== String(ticketNumber || '').trim()) {
            const retry = await fetch(`${apiBase}/public/project-share/${shareToken}/nv-posr/${encodeURIComponent(base)}`);
            const retryData = await retry.json().catch(() => ({}));
            if (!retry.ok) {
                const msg = (retryData && retryData.error) || `Nevada 811 lookup failed (${retry.status})`;
                throw new Error(msg);
            }
            return retryData;
        }
        return data;
    }

    /** NV POSR blocks browser CORS — use share passthrough (viewer-initiated, no DB write). */
    async function fetchNvPosrForShareViewer(apiBase, shareToken, ticketNumber) {
        return fetchNvPosrViaShare(apiBase, shareToken, ticketNumber);
    }

    async function fetchNvMapPolygonViaShare(apiBase, shareToken, ticketNumber) {
        const tn = encodeURIComponent(String(ticketNumber || '').trim());
        const res = await fetch(`${apiBase}/public/project-share/${shareToken}/map-polygon/${tn}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = (data && data.error) || `Nevada 811 map lookup failed (${res.status})`;
            throw new Error(msg);
        }
        return data;
    }

    /** NV map page blocks browser CORS — use share passthrough (viewer-initiated, no DB write). */
    async function fetchNvMapPolygonForShareViewer(apiBase, shareToken, ticketNumber) {
        return fetchNvMapPolygonViaShare(apiBase, shareToken, ticketNumber);
    }

    window.projectShareNvPublic = {
        normalizeTicketBase,
        formatShareDateTime,
        parsePosrForShareDetail,
        mergeShareTicketWithNvPosr,
        fetchNvPosrViaShare,
        fetchNvPosrForShareViewer,
        fetchNvMapPolygonViaShare,
        fetchNvMapPolygonForShareViewer,
    };
})();
