// Build SubmitCurrentUserEnquiryAsync-shaped JSON for new tickets.
// Work type / activity: exact ids from data/newTicketLookups.json (enquiryCategories + activities).
// enquiryLocation + searchAddress: built from the last ReverseGeocodeCurrentUserAsync row (see createTicketWizard).

(function () {
    /** @type {Record<string, object>} */
    const lookupsCacheByType = {};

    const PROJECT_OWNER_SLUG_TO_LIST_NAME = {
        utility_facility_operator: 'Utility Facility Operator (non-municipality/county)',
        municipality: 'Municipality',
        county: 'County',
        other: 'Other',
    };

    function parsePositiveInt(raw) {
        const n = parseInt(String(raw != null ? raw : '').trim(), 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    function normalizeLoose(s) {
        if (s == null) return '';
        return String(s)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    function stripGovPrefix(s) {
        return String(s || '')
            .replace(/^city of /i, '')
            .replace(/^county of /i, '')
            .replace(/^town of /i, '')
            .trim();
    }

    function stateCodeFromGeocodeState(val) {
        if (val == null) return '';
        if (typeof val === 'string') return val.trim();
        if (typeof val === 'object') {
            const c = val.code != null ? String(val.code).trim() : '';
            if (c) return c;
            const v = val.value != null ? String(val.value).trim() : '';
            return v;
        }
        return '';
    }

    /**
     * @param {object} lookups
     * @param {string|number} categoryIdRaw enquiryCategories[].id (Type of Work)
     * @param {string|number} activityIdRaw activity id under that category
     * @returns {{ categoryId: number, activityId: number, purposeId: number, categoryName: string, activityName: string }}
     */
    function resolveWorkIdsFromLookupIds(lookups, categoryIdRaw, activityIdRaw) {
        const categoryId = parseInt(String(categoryIdRaw != null ? categoryIdRaw : '').trim(), 10);
        const activityId = parseInt(String(activityIdRaw != null ? activityIdRaw : '').trim(), 10);
        if (!Number.isFinite(categoryId) || categoryId <= 0) {
            throw new Error('Select type of work');
        }
        if (!Number.isFinite(activityId) || activityId <= 0) {
            throw new Error('Select work activity');
        }
        const cats = Array.isArray(lookups.enquiryCategories) ? lookups.enquiryCategories : [];
        const cat = cats.find(function (c) {
            return c && Number(c.id) === categoryId && c.isActive !== false;
        });
        if (!cat) {
            throw new Error('Invalid type of work selection');
        }
        const activities = Array.isArray(cat.activities) ? cat.activities : [];
        const act = activities.find(function (a) {
            return a && Number(a.id) === activityId && Number(a.categoryId) === categoryId && a.isActive !== false;
        });
        if (!act) {
            throw new Error('Invalid work activity for the selected type of work');
        }
        const purposeId =
            cat.purposeId != null && Number.isFinite(Number(cat.purposeId)) ? Number(cat.purposeId) : 0;
        return {
            categoryId: categoryId,
            activityId: activityId,
            purposeId: purposeId,
            categoryName: String(cat.name || ''),
            activityName: String(act.name || ''),
        };
    }

    /**
     * @param {object|null|undefined} reverseGeoRow row from ReverseGeocodeCurrentUserAsync (must include geocodedAddress)
     * @param {{ x: number, y: number }} centroid polygon centroid lon/lat (fallback when row.coordinates is absent)
     * @param {string} nearestCrossStreet user-entered nearest cross street (not from geocoder)
     */
    function enquiryLocationAndSearchAddressFromReverseGeocode(reverseGeoRow, centroid, nearestCrossStreet) {
        const addr = reverseGeoRow && reverseGeoRow.geocodedAddress;
        if (!addr || typeof addr !== 'object') {
            throw new Error(
                'Address fields for the payload come from polygon reverse geocode. Draw the dig area and wait for address lookup to finish (or change type of work and let lookup run again), then preview.'
            );
        }
        const street = addr.street != null ? String(addr.street).trim() : '';
        const suburb = addr.suburb != null ? String(addr.suburb).trim() : '';
        const postcode = addr.postcode != null ? String(addr.postcode).trim() : '';
        const county = addr.county != null ? String(addr.county).trim() : '';
        const stateCode = stateCodeFromGeocodeState(addr.state);

        let x = centroid.x;
        let y = centroid.y;
        const coords = reverseGeoRow.coordinates;
        if (coords && typeof coords === 'object') {
            const cx =
                coords.x != null
                    ? Number(coords.x)
                    : coords.longitude != null
                      ? Number(coords.longitude)
                      : NaN;
            const cy =
                coords.y != null
                    ? Number(coords.y)
                    : coords.latitude != null
                      ? Number(coords.latitude)
                      : NaN;
            if (Number.isFinite(cx) && Number.isFinite(cy)) {
                x = cx;
                y = cy;
            }
        }

        const enquiryLocation = {
            street: street,
            suburb: suburb,
            postcode: postcode,
            county: county,
            state: stateCode,
        };
        const searchAddress = {
            isExact: true,
            prefix: '',
            street: street,
            suburb: suburb,
            county: county,
            postcode: postcode,
            coordinates: {
                x: Number(x.toFixed(6)),
                y: Number(y.toFixed(6)),
            },
            locationType: 'R',
            searchMethod: 'Street',
            townCity: '',
            intersectionStreetName: String(nearestCrossStreet || '').trim(),
            mapReference: '',
        };
        return { enquiryLocation: enquiryLocation, searchAddress: searchAddress };
    }

    /**
     * @param {GeoJSON.Polygon} geo
     * @returns {{ x: number, y: number }}
     */
    function polygonCentroidLonLat(geo) {
        if (!geo || geo.type !== 'Polygon' || !Array.isArray(geo.coordinates) || !geo.coordinates[0]) {
            throw new Error('Invalid GeoJSON polygon');
        }
        let ring = geo.coordinates[0];
        if (ring.length < 3) throw new Error('Polygon ring too short');
        const n = ring.length;
        if (
            n > 1 &&
            ring[0][0] === ring[n - 1][0] &&
            ring[0][1] === ring[n - 1][1]
        ) {
            ring = ring.slice(0, -1);
        }
        let twice = 0;
        let cx = 0;
        let cy = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0];
            const yi = ring[i][1];
            const xj = ring[j][0];
            const yj = ring[j][1];
            const f = xj * yi - xi * yj;
            twice += f;
            cx += (xj + xi) * f;
            cy += (yj + yi) * f;
        }
        if (Math.abs(twice) < 1e-18) {
            let sx = 0;
            let sy = 0;
            const nv = ring.length;
            for (let i = 0; i < nv; i++) {
                sx += ring[i][0];
                sy += ring[i][1];
            }
            return { x: sx / nv, y: sy / nv };
        }
        const inv = 1 / (3 * twice);
        return { x: cx * inv, y: cy * inv };
    }

    function geoJsonPolygonToWkt(geo) {
        if (!geo || geo.type !== 'Polygon' || !Array.isArray(geo.coordinates) || !geo.coordinates[0]) {
            throw new Error('Invalid GeoJSON polygon');
        }
        const ring = geo.coordinates[0];
        const parts = ring.map(function (pt) {
            if (!Array.isArray(pt) || pt.length < 2) throw new Error('Invalid ring coordinate');
            return String(pt[0]) + ' ' + String(pt[1]);
        });
        return 'POLYGON((' + parts.join(',') + '))';
    }

    function resolveExcavationMethodId(list, label) {
        const s = String(label || '').trim();
        if (!s) throw new Error('Select an excavation method');
        const rows = Array.isArray(list) ? list : [];
        const row = rows.find(function (r) {
            return r && r.name === s && r.isActive !== false;
        });
        if (!row || row.id == null) {
            throw new Error('Unknown excavation method: ' + s);
        }
        return Number(row.id);
    }

    function resolveWorkingOnBehalfOfId(list, ownerTypeRaw) {
        const typeId = parsePositiveInt(ownerTypeRaw);
        if (typeId != null) {
            const rows = Array.isArray(list) ? list : [];
            const row = rows.find(function (r) {
                return r && Number(r.id) === typeId && r.isActive !== false;
            });
            if (row) return typeId;
        }
        const name = PROJECT_OWNER_SLUG_TO_LIST_NAME[ownerTypeRaw];
        if (!name) throw new Error('Select project owner type');
        const rows = Array.isArray(list) ? list : [];
        const row = rows.find(function (r) {
            return r && r.name === name && r.isActive !== false;
        });
        if (!row || row.id == null) throw new Error('Could not resolve working-on-behalf type');
        return Number(row.id);
    }

    function resolveWorkingOnBehalfOfAuthId(authorities, behalfId, ownerAuthRaw, ownerNameRaw) {
        const authId = parsePositiveInt(ownerAuthRaw);
        if (authId != null) {
            const list = Array.isArray(authorities) ? authorities : [];
            const row = list.find(function (a) {
                return a && Number(a.id) === authId && a.isActive !== false;
            });
            if (!row) throw new Error('Select project owner name');
            if (Number(row.workingOfBehalfOfId) !== Number(behalfId)) {
                throw new Error('Selected project owner name does not match the project owner type');
            }
            return authId;
        }
        const list = (Array.isArray(authorities) ? authorities : []).filter(function (a) {
            return a && a.workingOfBehalfOfId === behalfId && a.isActive !== false;
        });
        const owner = String(ownerNameRaw || '').trim();
        const ownerCore = stripGovPrefix(owner);
        const ownerNorm = normalizeLoose(owner);

        let best = null;
        let bestScore = -1;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            const n = String(a.name || '');
            const core = stripGovPrefix(n);
            const norm = normalizeLoose(n);
            let score = 0;
            if (owner) {
                if (n.toLowerCase() === owner.toLowerCase()) score = 10000;
                else if (core && ownerCore && core.toLowerCase() === ownerCore.toLowerCase()) score = 8000;
                else if (norm && ownerNorm && (norm.includes(ownerNorm) || ownerNorm.includes(norm))) score = 5000;
                else if (
                    ownerNorm &&
                    norm.split(' ').some(function (w) {
                        return w.length > 3 && ownerNorm.includes(w);
                    })
                )
                    score = 500;
            }
            if (score > bestScore) {
                bestScore = score;
                best = a;
            }
        }

        if (best && bestScore >= 500) return Number(best.id);

        if (behalfId === 1) {
            const fallback = list.find(function (a) {
                return /other\s*\/\s*not listed/i.test(String(a.name || ''));
            });
            if (fallback) return Number(fallback.id);
        }
        if (behalfId === 4) {
            const home = list.find(function (a) {
                return /homeowner|property owner|tenant|hoa/i.test(String(a.name || ''));
            });
            if (home) return Number(home.id);
        }
        if (list.length === 1) return Number(list[0].id);
        return best ? Number(best.id) : null;
    }

    function toIsoDateParts(iso) {
        if (!iso || typeof iso !== 'string') return null;
        const m =
            iso.match(
                /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?([+-]\d{2}:\d{2}|Z)?$/
            ) || [];
        if (m.length < 6) return null;
        const offset = m[6] && m[6] !== 'Z' ? m[6] : '+00:00';
        return { yyyy: m[1], mm: m[2], dd: m[3], hh: m[4], min: m[5], offset: offset };
    }

    function formatDateForSubmit(iso) {
        const p = toIsoDateParts(iso);
        if (!p) return null;
        return p.dd + '/' + p.mm + '/' + p.yyyy;
    }

    function formatTimeForSubmit(iso) {
        const p = toIsoDateParts(iso);
        if (!p) return null;
        return p.hh + ':' + p.min;
    }

    function normalizePhone(s) {
        if (s == null) return '';
        return String(s).replace(/[^\d+]/g, '');
    }

    function yn(v) {
        return v === 'yes';
    }

    function hasPermitNames(permitVal) {
        const v = String(permitVal || '').trim();
        if (!v || v === 'No Permit required') return ['No Permit required'];
        return [v];
    }

    /** Principal contact name: letters and spaces only, max 40 characters. */
    function validatePrincipalContactName(raw) {
        const s = String(raw != null ? raw : '').trim();
        if (!s) {
            return { ok: false, message: 'Enter principal contact name' };
        }
        if (s.length > 40) {
            return {
                ok: false,
                message: 'Principal contact name must be 40 characters or fewer',
            };
        }
        if (!/^[A-Za-z ]+$/.test(s)) {
            return {
                ok: false,
                message: 'Principal contact name must contain letters only',
            };
        }
        return { ok: true, value: s };
    }

    /** Principal contact mobile: exactly 10 digits. */
    function validatePrincipalContactMobile(raw) {
        const digits = String(raw != null ? raw : '').replace(/\D/g, '');
        if (!digits) {
            return { ok: false, message: 'Enter principal contact mobile' };
        }
        if (!/^\d{10}$/.test(digits)) {
            return {
                ok: false,
                message: 'Principal contact mobile must be exactly 10 digits',
            };
        }
        return { ok: true, value: digits };
    }

    /** Matches USAN NearestCrossStreet rules (required; no special characters). */
    function validateNearestCrossStreet(raw) {
        const s = String(raw != null ? raw : '').trim();
        if (!s) {
            return { ok: false, message: 'Enter the nearest cross street (e.g. Oak Ave).' };
        }
        if (!/^[A-Za-z0-9 .'-]+$/.test(s)) {
            return {
                ok: false,
                message:
                    'Nearest cross street can only contain letters, numbers, spaces, periods, hyphens, and apostrophes.',
            };
        }
        if (!/[A-Za-z]/.test(s)) {
            return { ok: false, message: 'Nearest cross street must include a street name.' };
        }
        return { ok: true, value: s };
    }

    function normalizeTicketType(ticketType) {
        const api = window.ticketCommencementDatesApi;
        if (api && typeof api.normalizeTicketType === 'function') {
            return api.normalizeTicketType(ticketType);
        }
        const t = String(ticketType || 'Normal').trim();
        return t === 'Short' || t === 'Emergency' ? t : 'Normal';
    }

    function purposeIdFromTicketType(ticketType) {
        const api = window.ticketCommencementDatesApi;
        if (api && typeof api.purposeIdFromTicketType === 'function') {
            return api.purposeIdFromTicketType(ticketType);
        }
        const t = normalizeTicketType(ticketType);
        if (t === 'Short') return 1;
        if (t === 'Emergency') return 3;
        return 0;
    }

    function lookupFileForTicketType(ticketType) {
        const t = normalizeTicketType(ticketType);
        if (t === 'Short') return 'newTicketLookupsShort.json';
        if (t === 'Emergency') return 'newTicketLookupsEmergency.json';
        return 'newTicketLookups.json';
    }

    /**
     * @param {string} [ticketType] Normal | Short | Emergency
     * @returns {Promise<object>}
     */
    async function loadNewTicketLookups(ticketType) {
        const type = normalizeTicketType(ticketType);
        if (lookupsCacheByType[type]) return lookupsCacheByType[type];
        const file = lookupFileForTicketType(type);
        const url = new URL('data/' + file, window.location.href);
        const res = await fetch(url.toString(), { credentials: 'same-origin' });
        if (!res.ok) {
            throw new Error('Failed to load ' + file + ' (' + res.status + ')');
        }
        lookupsCacheByType[type] = await res.json();
        return lookupsCacheByType[type];
    }

    function formatCommencesDateFromYmd(ymd) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
        if (!m) throw new Error('Select a valid planned work start date');
        return m[3] + '/' + m[2] + '/' + m[1];
    }

    function formatCommencesTimeFromHm(hm) {
        const tm = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
        if (!tm) throw new Error('Select a valid work start time');
        const hh = String(parseInt(tm[1], 10)).padStart(2, '0');
        return hh + ':' + tm[2];
    }

    /**
     * @param {object} state normalized wizard state (startDateYmd, startTimeHm)
     * @param {object} lookups
     */
    function buildNewTicketPayload(state, lookups) {
        const geo = state.polygonGeoJson;
        if (!geo || geo.type !== 'Polygon') {
            throw new Error('Draw a ticket area polygon first');
        }

        const wkt = geoJsonPolygonToWkt(geo);
        const centroid = polygonCentroidLonLat(geo);

        const work = resolveWorkIdsFromLookupIds(lookups, state.workCategoryId, state.workActivityId);
        const excavationMethodId = resolveExcavationMethodId(lookups.excavationMethodList, state.excavationMethod);

        if (!state.projectOwnerTypeId && !state.projectOwnerTypeSlug) {
            throw new Error('Select project owner type');
        }
        const workingOnBehalfOfId = resolveWorkingOnBehalfOfId(
            lookups.workingOnBehalfOfList,
            state.projectOwnerTypeId || state.projectOwnerTypeSlug
        );
        const workingOnBehalfOfAuthId = resolveWorkingOnBehalfOfAuthId(
            lookups.workingOnBehalfAuthorityOfList,
            workingOnBehalfOfId,
            state.projectOwnerAuthId,
            state.projectOwnerName
        );
        if (workingOnBehalfOfAuthId == null || !Number.isFinite(workingOnBehalfOfAuthId)) {
            throw new Error('Select project owner name');
        }

        if (!state.startDateYmd) throw new Error('Select planned work start date');
        if (!state.startTimeHm) throw new Error('Select work start time');
        if (
            window.ticketCommencementDatesApi &&
            typeof window.ticketCommencementDatesApi.validateCommencementDateTime === 'function'
        ) {
            const commence = window.ticketCommencementDatesApi.validateCommencementDateTime(
                state.startDateYmd,
                state.startTimeHm,
                undefined,
                state.ticketType
            );
            if (!commence.ok) throw new Error(commence.message || 'Invalid planned work start date/time');
        }
        const commencesOnDate = formatCommencesDateFromYmd(state.startDateYmd);
        const commencesOnTime = formatCommencesTimeFromHm(state.startTimeHm);

        const loc = enquiryLocationAndSearchAddressFromReverseGeocode(
            state.reverseGeocodeRow,
            centroid,
            state.nearestCrossStreet
        );

        const principalNameResult = validatePrincipalContactName(state.principalName);
        if (!principalNameResult.ok) throw new Error(principalNameResult.message);
        const principalMobileResult = validatePrincipalContactMobile(state.principalMobile);
        if (!principalMobileResult.ok) throw new Error(principalMobileResult.message);
        const principalName = principalNameResult.value;
        const principalMobile = principalMobileResult.value;

        const crossStreet = validateNearestCrossStreet(state.nearestCrossStreet);
        if (!crossStreet.ok) throw new Error(crossStreet.message);

        return {
            WorkDurationName: null,
            enquiryMedium: null,
            ticketCreationMethod: 'New',
            searchRegionId: null,
            activityId: work.activityId,
            categoryId: work.categoryId,
            purposeId: purposeIdFromTicketType(state.ticketType),
            additionalNotes: String(state.scope || '').trim(),
            assetLocateRequired: null,
            commencesOnDate: commencesOnDate,
            commencesOnTime: commencesOnTime,
            CompletesOnDate: null,
            designCompletesOnDate: null,
            assetLocateOn: null,
            plansRequired: null,
            planPaperSizeId: null,
            planPaperScale: null,
            searchLocationString: '',
            spatialObjectNativeDescription: wkt,
            spatialObjectNativeProjection: 'EPSG:4326',
            IsSpatialObjectCircle: false,
            excavationMethodId: excavationMethodId,
            excavationDepthId: null,
            principalContactName: principalName,
            principalContactMobile: principalMobile,
            nearestCrossStreet: crossStreet.value,
            lotNoSubdivision: null,
            excavatorDoingWork: null,
            workingOnBehalfOfId: workingOnBehalfOfId,
            workingOnBehalfOfAuthId: workingOnBehalfOfAuthId,
            locationInRoad: null,
            isPrivateLocateRequired: null,
            workplaceLocations: [],
            userReference: String(state.jobName || '').trim(),
            isAreaPreMarked: null,
            AreaPreMarked: String(state.areaPreMarked || '').trim() || 'Other (see Digsite Location Details)',
            clonedFromEnquiryID: 0,
            enquiryLocation: loc.enquiryLocation,
            createCar: null,
            searchAddress: loc.searchAddress,
            isIntersectionSearch: false,
            manuallyAddedAuthorities: [],
            manuallyRemovedAuthortities: [],
            ammendReason: '',
            isOperatorFault: false,
            workLegalStartDate: null,
            petOnProperty: null,
            inBodyOfWater: null,
            isBoring: yn(state.horizontalBoring),
            isBlasting: yn(state.explosives),
            isExcavationOnRoadWay: yn(state.streetSidewalkParkstrip),
            isExcavationOnlyWithinPavement: null,
            isVacuumExcavation: null,
            permitNumber: null,
            hasPermitForNames: hasPermitNames(state.permitExcavation),
            PreviousExternalRequestNumber: null,
            sharedByUser: null,
            isUsingSearchedCoordsForConfirmedCoords: false,
            xSearchedCoordinate: null,
            ySearchedCoordinate: null,
            previousTicketTypeCarriedOverByExternalUser: false,
            alpOption: null,
            smsOptIn: null,
        };
    }

    window.newTicketPayloadApi = {
        normalizeTicketType: normalizeTicketType,
        purposeIdFromTicketType: purposeIdFromTicketType,
        loadNewTicketLookups: loadNewTicketLookups,
        buildNewTicketPayload: buildNewTicketPayload,
        validateNearestCrossStreet: validateNearestCrossStreet,
        validatePrincipalContactName: validatePrincipalContactName,
        validatePrincipalContactMobile: validatePrincipalContactMobile,
        resolveWorkIdsFromLookupIds: resolveWorkIdsFromLookupIds,
        enquiryLocationAndSearchAddressFromReverseGeocode: enquiryLocationAndSearchAddressFromReverseGeocode,
        polygonCentroidLonLat: polygonCentroidLonLat,
        geoJsonPolygonToWkt: geoJsonPolygonToWkt,
    };
})();
