/**
 * Job misc compliance date attention rules.
 * Keep in sync with cloudflare/deploy/src/lib/jobComplianceDates.cjs
 *
 * Future: holiday-aware business days (not yet implemented).
 * ("Holiday-aware business days (compliance + commencement)").
 */
(function (global) {
    'use strict';

    const JOB_COMPLIANCE_ATTENTION_BUSINESS_DAYS = 3;
    const JOB_COMPLIANCE_DATE_NA = 'N/A';
    const USAN_TZ = 'America/Los_Angeles';

    function isComplianceDateNa(dateStr) {
        if (dateStr == null) return false;
        return /^n\/a$/i.test(String(dateStr).trim());
    }

    function isComplianceDateMissing(dateStr) {
        if (dateStr == null) return true;
        return String(dateStr).trim() === '';
    }

    function parseYmd(ymd) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
        if (!m) return null;
        const y = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        const d = parseInt(m[3], 10);
        if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
        return { y: y, m: mo, d: d };
    }

    function ymdInTimeZone(date, timeZone) {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(date);
    }

    function ymdToUtcDate(ymd) {
        const p = parseYmd(ymd);
        if (!p) return null;
        return new Date(Date.UTC(p.y, p.m - 1, p.d));
    }

    function dateToYmd(d) {
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }

    function isWeekendYmd(ymd) {
        const d = ymdToUtcDate(ymd);
        if (!d) return false;
        const dow = d.getUTCDay();
        return dow === 0 || dow === 6;
    }

    function addDaysToYmd(ymd, days) {
        const d = ymdToUtcDate(ymd);
        if (!d) return null;
        d.setUTCDate(d.getUTCDate() + days);
        return dateToYmd(d);
    }

    function addWeekdaysFromYmd(startYmd, count) {
        let ymd = startYmd;
        let added = 0;
        while (added < count) {
            ymd = addDaysToYmd(ymd, 1);
            if (!ymd) return null;
            if (!isWeekendYmd(ymd)) added++;
        }
        return ymd;
    }

    function isComplianceDateAttentionRequired(dateStr, now) {
        if (dateStr == null) return false;
        const d = String(dateStr).trim();
        if (isComplianceDateNa(d)) return false;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
        const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
        const todayYmd = ymdInTimeZone(ref, USAN_TZ);
        const thresholdYmd = addWeekdaysFromYmd(todayYmd, JOB_COMPLIANCE_ATTENTION_BUSINESS_DAYS);
        if (!thresholdYmd) return false;
        return d <= thresholdYmd;
    }

    function computeJobComplianceAttentionRequired(compliance) {
        const c = compliance || {};
        const standardFields = [
            c.permitExpiration,
            c.trafficControlPermitExpiration,
            c.thirdPartyInspectionDate,
        ];
        for (let i = 0; i < standardFields.length; i++) {
            if (isComplianceDateMissing(standardFields[i])) return true;
        }
        if (isComplianceDateAttentionRequired(c.permitExpiration)) return true;
        if (isComplianceDateAttentionRequired(c.trafficControlPermitExpiration)) return true;
        if (isComplianceDateAttentionRequired(c.thirdPartyInspectionDate)) return true;
        const items = Array.isArray(c.customItems) ? c.customItems : [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item) continue;
            const label = item.label != null ? String(item.label).trim() : '';
            if (!label) continue;
            if (isComplianceDateMissing(item.date)) return true;
            if (isComplianceDateAttentionRequired(item.date)) return true;
        }
        return false;
    }

    function jobComplianceDateAttentionTitle() {
        return 'Due within ' + JOB_COMPLIANCE_ATTENTION_BUSINESS_DAYS + ' business days or overdue';
    }

    function jobComplianceDateMissingTitle() {
        return 'Set a date or choose N/A';
    }

    global.jobComplianceDatesApi = {
        JOB_COMPLIANCE_ATTENTION_BUSINESS_DAYS: JOB_COMPLIANCE_ATTENTION_BUSINESS_DAYS,
        JOB_COMPLIANCE_DATE_NA: JOB_COMPLIANCE_DATE_NA,
        isComplianceDateNa: isComplianceDateNa,
        isComplianceDateMissing: isComplianceDateMissing,
        isComplianceDateAttentionRequired: isComplianceDateAttentionRequired,
        computeJobComplianceAttentionRequired: computeJobComplianceAttentionRequired,
        jobComplianceDateAttentionTitle: jobComplianceDateAttentionTitle,
        jobComplianceDateMissingTitle: jobComplianceDateMissingTitle,
    };
})(typeof window !== 'undefined' ? window : globalThis);
