/**
 * User preference: how far back to show recent org photos on the map (#171).
 */
(function () {
    const MAP_RECENT_OFF = 0;
    const MAP_RECENT_TODAY = 1;
    const MAP_RECENT_OPTIONS = [MAP_RECENT_OFF, MAP_RECENT_TODAY, 7, 30, 90];
    const MAP_RECENT_DEFAULT = 7;

    function normalizeMapRecentPhotosDaysBack(value) {
        const n = Number(value);
        if (MAP_RECENT_OPTIONS.indexOf(n) !== -1) return n;
        return MAP_RECENT_DEFAULT;
    }

    function formatMapRecentPhotosLabel(days) {
        const n = normalizeMapRecentPhotosDaysBack(days);
        if (n === MAP_RECENT_OFF) return 'Off';
        if (n === MAP_RECENT_TODAY) return 'Today';
        return `Last ${n} days`;
    }

    function getMapRecentPhotosDaysBack() {
        const p = typeof window.getUserProfile === 'function' ? window.getUserProfile() : {};
        return normalizeMapRecentPhotosDaysBack(p.mapRecentPhotosDaysBack);
    }

    function getPacificYmd(date) {
        if (typeof window.getPacificYmd === 'function') {
            return window.getPacificYmd(date || new Date());
        }
        const tz = window.DISPLAY_TIMEZONE || 'America/Los_Angeles';
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(date || new Date());
    }

    function pacificYmdHmToUtcMs(ymd, hours, minutes, seconds) {
        if (typeof window.pacificYmdHmToUtcMs === 'function') {
            return window.pacificYmdHmToUtcMs(ymd, hours, minutes, seconds);
        }
        return Date.UTC(parseInt(String(ymd).slice(0, 4), 10), parseInt(String(ymd).slice(5, 7), 10) - 1, parseInt(String(ymd).slice(8, 10), 10), hours || 0, minutes || 0, seconds || 0);
    }

    function mapRecentPhotosCreatedFromIso(daysBack) {
        const n = normalizeMapRecentPhotosDaysBack(daysBack != null ? daysBack : getMapRecentPhotosDaysBack());
        if (n <= MAP_RECENT_OFF) return null;
        const todayYmd = getPacificYmd(new Date());
        if (n === MAP_RECENT_TODAY) {
            return new Date(pacificYmdHmToUtcMs(todayYmd, 0, 0, 0)).toISOString();
        }
        const fromYmd =
            typeof window.addPacificYmdDays === 'function'
                ? window.addPacificYmdDays(todayYmd, -(n - 1))
                : todayYmd;
        return new Date(pacificYmdHmToUtcMs(fromYmd, 0, 0, 0)).toISOString();
    }

    window.mapRecentPhotosPreferenceModule = {
        MAP_RECENT_OFF,
        MAP_RECENT_TODAY,
        MAP_RECENT_OPTIONS,
        MAP_RECENT_DEFAULT,
        normalizeMapRecentPhotosDaysBack,
        formatMapRecentPhotosLabel,
        getMapRecentPhotosDaysBack,
        mapRecentPhotosCreatedFromIso,
    };
})();
