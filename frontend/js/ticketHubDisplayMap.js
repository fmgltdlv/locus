/**
 * Ticket Hub — maps **stored** `ticket` / `ticket_data` to **detail grid** values.
 *
 * **Sources**
 * - **Provider API:** `GetCurrentUserEnquiryAsync` merged server-side → canonical keys + `provider*`.
 * - **Public / Portal:** `ticketBuilder.buildFromPosr` → flattened portal scalars on the ticket (e.g. `address`, `portalTicketType`).
 * - **List enrichment:** mostly ids + polygon; not duplicate portal text.
 *
 * **Canonical reference:** `docs/ticket-field-sources.md` (full table). `FIELD_SOURCES_PROVENANCE` below is a short index.
 *
 * Add or reorder `HUB_FIELD_SOURCES` / `HUB_FIELD_PICKERS` when UI and storage diverge.
 */
(function () {
    'use strict';
    const LEGACY_FIELDS = {
        providerTicketType: 'ng' + 'enTicketType',
        providerPreviousRequestNumber: 'ng' + 'enPreviousRequestNumber',
        providerEnquiryStatus: 'ng' + 'enEnquiryStatus',
        providerLodgedOn: 'ng' + 'enLodgedOn',
        providerLastUpdatedTime: 'ng' + 'enLastUpdatedTime',
        providerUserReference: 'ng' + 'enUserReference',
        providerNotes: 'ng' + 'enNotes',
        providerPriority: 'ng' + 'enPriority',
        providerWorkingOnBehalf: 'ng' + 'enWorkingOnBehalf',
        providerWorkingOnBehalfOfAuth: 'ng' + 'enWorkingOnBehalfOfAuth',
        providerExcavationDepth: 'ng' + 'enExcavationDepth',
        providerPrincipalContactName: 'ng' + 'enPrincipalContactName',
        providerPrincipalContactPhone: 'ng' + 'enPrincipalContactPhone',
    };

    function firstNonEmpty(...vals) {
        for (let i = 0; i < vals.length; i++) {
            const v = vals[i];
            if (v == null) continue;
            if (typeof v === 'object' && v !== null && !Array.isArray(v)) continue;
            const t = String(v).trim();
            if (t !== '') return v;
        }
        return null;
    }

    /**
     * Read a dotted path from ticket (scalar leaf values only).
     * @param {object} ticket
     * @param {string} path
     */
    function readPath(ticket, path) {
        if (!ticket || !path || typeof path !== 'string') return null;
        const parts = path.split('.');
        let cur = ticket;
        for (let i = 0; i < parts.length; i++) {
            if (cur == null || typeof cur !== 'object') return null;
            cur = cur[parts[i]];
        }
        if (cur == null) return null;
        if (typeof cur === 'object' && !Array.isArray(cur)) return null;
        const s = String(cur).trim();
        return s === '' ? null : cur;
    }

    /**
     * Dig-site line (locate), not excavator mailing — mirrors backend/frontend portal pick order.
     * @param {object} ticket
     * @returns {string|null}
     */
    function pickDigSiteAddress(ticket) {
        const fromFull =
            ticket && ticket.fullAddress != null && String(ticket.fullAddress).trim() !== ''
                ? String(ticket.fullAddress).trim()
                : null;
        if (fromFull) return fromFull;
        return firstNonEmpty(ticket.address, ticket.locationSummary);
    }

    function pickTicketScope(ticket) {
        const legacyDetailSource = 'ng' + 'en_enquiry_search';
        if (ticket && (ticket.ticketDetailsSource === 'provider_enquiry_search' || ticket.ticketDetailsSource === legacyDetailSource)) {
            const legacyNotes = LEGACY_FIELDS.providerNotes;
            return firstNonEmpty(ticket.scopeOfWork, ticket.providerNotes, ticket[legacyNotes]);
        }
        return firstNonEmpty(ticket.scopeOfWork, ticket.ticketScope, ticket.additionalRemarks);
    }

    function pickNearbyCrossStreet(ticket) {
        const v1 = ticket && ticket.nearbyCrossStreet;
        const v2 = ticket && ticket.nearestCrossStreet;
        const unwrap = (v) => {
            if (v == null) return null;
            if (typeof v === 'object' && v && 'value' in v && v.value != null && String(v.value).trim() !== '') {
                return String(v.value).trim();
            }
            if (typeof v === 'string' || typeof v === 'number') {
                const s = String(v).trim();
                return s || null;
            }
            return null;
        };
        return firstNonEmpty(unwrap(v1), unwrap(v2));
    }

    /** Provider ticket type; not Pelican XML `ticketType`. */
    function pickProviderTicketType(ticket) {
        const legacy = LEGACY_FIELDS.providerTicketType;
        return firstNonEmpty(
            ticket.providerTicketType,
            ticket.ngenTicketType,
            ticket[legacy],
            ticket.portalTicketType,
            ticket.ticketType
        );
    }

    /** USAN enquiry status (RNEW, Remark, New, Cancelled, …) — current revision. */
    function pickUsanEnquiryStatus(ticket) {
        const legacy = LEGACY_FIELDS.providerEnquiryStatus;
        return firstNonEmpty(
            ticket.providerEnquiryStatus,
            ticket.ngenEnquiryStatus,
            ticket.currentNgenEnquiryStatus,
            ticket.current_ngen_enquiry_status,
            ticket.ngen_enquiry_status,
            ticket.provider_enquiry_status,
            ticket[legacy]
        );
    }

    /**
     * Display ticket purpose type with USAN status, e.g. "Normal - RNEW", "Short - Remark".
     * @param {object} ticket
     * @returns {string|null}
     */
    function formatTicketTypeWithUsanStatus(ticket) {
        const typeRaw = pickProviderTicketType(ticket);
        const statusRaw = pickUsanEnquiryStatus(ticket);
        const typeStr = typeRaw != null ? String(typeRaw).trim() : '';
        const statusStr = statusRaw != null ? String(statusRaw).trim() : '';
        if (typeStr && statusStr) return `${typeStr} - ${statusStr}`;
        if (typeStr) return typeStr;
        if (statusStr) return statusStr;
        return null;
    }

    /** Portal work type string from raw/root (for internal fallbacks). */
    function pickPortalWorkTypeRaw(ticket) {
        return firstNonEmpty(ticket.workType);
    }

    /**
     * Single display field: provider `workActivity` when present, else portal work type/activity.
     */
    function pickWorkActivityUnified(ticket) {
        return firstNonEmpty(ticket.workActivity, pickPortalWorkTypeRaw(ticket));
    }

    function pickCategoryOfWork(ticket) {
        return firstNonEmpty(ticket.categoryOfWork, pickPortalWorkTypeRaw(ticket));
    }

    function pickProviderWorkingOnBehalf(ticket) {
        const leg = LEGACY_FIELDS.providerWorkingOnBehalf;
        return firstNonEmpty(ticket.providerWorkingOnBehalf, ticket.ngenWorkingOnBehalf, ticket[leg]);
    }

    function pickProviderWorkingOnBehalfOfAuth(ticket) {
        const leg = LEGACY_FIELDS.providerWorkingOnBehalfOfAuth;
        return firstNonEmpty(
            ticket.providerWorkingOnBehalfOfAuth,
            ticket.ngenWorkingOnBehalfOfAuth,
            ticket.projectOwner,
            ticket[leg]
        );
    }

    function pickProviderExcavationDepth(ticket) {
        const leg = LEGACY_FIELDS.providerExcavationDepth;
        return firstNonEmpty(ticket.providerExcavationDepth, ticket.ngenExcavationDepth, ticket[leg]);
    }

    /** Created-by line: ticket `createdBy`; else nGen lodged-by / principal. */
    function pickCreatedByDisplay(ticket) {
        return firstNonEmpty(
            ticket.createdBy,
            ticket.lodgedByUserName,
            ticket.originalLodgedByUserName,
            ticket.ngenPrincipalContactName
        );
    }

    function pickJobName(ticket) {
        const legacyRef = LEGACY_FIELDS.providerUserReference;
        return firstNonEmpty(
            ticket.jobName,
            ticket.providerUserReference,
            ticket.ngenUserReference,
            ticket[legacyRef],
            ticket.userReference,
            ticket.jobNumberName
        );
    }

    function pickBoringDisplay(ticket) {
        if (ticket && ticket.isBoring === true) return true;
        if (ticket && ticket.isBoring === false) return false;
        return ticket && ticket.boring;
    }

    function pickBlastingDisplay(ticket) {
        if (ticket && ticket.isBlasting === true) return true;
        if (ticket && ticket.isBlasting === false) return false;
        return ticket && ticket.explosives;
    }

    function pickZip(ticket) {
        return firstNonEmpty(ticket.zipcode, ticket.zipCode);
    }

    function pickWorkDescription(ticket) {
        return firstNonEmpty(ticket.workDescription, ticket.workActivity, ticket.workType);
    }

    /**
     * Logical field id → function(ticket) => value | null.
     * Prefer adding a function here when fallbacks are custom; otherwise use HUB_FIELD_SOURCES string paths.
     */
    const HUB_FIELD_PICKERS = {
        digSiteAddress: pickDigSiteAddress,
        nearbyCrossStreet: pickNearbyCrossStreet,
        ticketScope: pickTicketScope,
        zip: pickZip,
        workDescription: pickWorkDescription,
        jobName: pickJobName,
        providerTicketType: pickProviderTicketType,
        /** Unified: activity (provider) or portal work type/activity. */
        workActivity: pickWorkActivityUnified,
        portalWorkType: pickPortalWorkTypeRaw,
        categoryOfWork: pickCategoryOfWork,
        boring: pickBoringDisplay,
        explosives: pickBlastingDisplay,
        createdBy: pickCreatedByDisplay,
        providerWorkingOnBehalf: pickProviderWorkingOnBehalf,
        providerWorkingOnBehalfOfAuth: pickProviderWorkingOnBehalfOfAuth,
        providerExcavationDepth: pickProviderExcavationDepth,
    };

    /**
     * Short index: hub field id → where data originates (see `docs/ticket-field-sources.md`).
     * Values are single-line hints, not full paths.
     * @type {Record<string, { provider?: string, portal?: string, source?: string }>}
     */
    const FIELD_SOURCES_PROVENANCE = {
        digSiteAddress: {
            provider: 'tickets.full_address / enquiryDetails.fullAddress; digSiteAddress → address',
            portal: 'ticket.address / locationSummary (pickDigSiteAddress)',
            source: 'JobWkt → polygon only',
        },
        locationSummary: { provider: 'same line as address when from provider', portal: 'ticket.locationSummary' },
        city: { provider: 'digSiteAddress.suburb | townCity | city', portal: 'ticket.city' },
        county: { provider: 'digSiteAddress.county', portal: 'ticket.county' },
        state: { provider: 'digSiteAddress.state', portal: 'ticket.state' },
        zip: { provider: 'digSiteAddress.postcode', portal: 'ticket.zipcode' },
        nearbyCrossStreet: { provider: 'nearestCrossStreet', portal: 'ticket.nearbyCrossStreet' },
        providerTicketType: { provider: 'purpose.value → providerTicketType' },
        categoryOfWork: { provider: 'category.value → categoryOfWork' },
        portalWorkType: { portal: 'ticket.workType (internal); hub shows unified workActivity' },
        workType: { portal: 'legacy path for portal workType string' },
        workActivity: { provider: 'activity.value', portal: 'workActivity or workType (unified display)' },
        workDescription: { provider: 'activity — category — purpose', portal: 'ticket.workDescription / workActivity' },
        excavationMethod: { provider: 'excavationMethod', portal: 'excavationMethod' },
        startTime: { provider: 'commencementDate', portal: 'requestDate' },
        legalStartDate: { provider: 'workLegalStartDate' },
        ticketExpirationDate: { provider: 'ticketExpiration', portal: 'dueDate / expiry fields' },
        endTime: { provider: 'ticketExpiration', portal: 'endTime' },
        lodgedByUserName: { provider: 'lodgedByUserName (lowercased)', portal: '—' },
        createdBy: { source: 'TextCreatedBy from source job row', portal: 'ticket.createdBy' },
        providerJobNumber: { provider: 'jobNumber', source: 'ticket_source_enrichment.job_number' },
        providerPreviousRequestNumber: { provider: 'previousRequestNumber' },
        providerEnquiryStatus: { provider: 'status' },
        providerLodgedOn: { provider: 'lodgedOn' },
        providerLastUpdatedTime: { provider: 'lastUpdatedTime' },
        ticketLastRefreshed: { source: 'POST /tickets/refresh success → ngenFullDetailRefreshedAt' },
        providerUserReference: { provider: 'userReference' },
        providerNotes: { provider: 'notes' },
        providerPriority: { provider: 'priority' },
        providerWorkingOnBehalf: { provider: 'workingOnBehalf' },
        providerWorkingOnBehalfOfAuth: { provider: 'workingOnBehalfOfAuth' },
        providerExcavationDepth: { provider: 'excavationDepth' },
        providerPrincipalContactName: { provider: 'principalContactName' },
        providerPrincipalContactPhone: { provider: 'principalContactPhone' },
        ticketScope: { provider: 'notes → scopeOfWork (no portal merge)', portal: 'ticket.ticketScope / additionalRemarks' },
        customerPhone: { portal: 'ticket.customerPhone' },
        customerMobile: { portal: 'ticket.customerMobile' },
        customerEmail: { portal: 'ticket.customerEmail' },
    };

    /**
     * Logical field id → ordered list of dotted paths under `ticket` (for generic resolution).
     * Grouping: address/location → work → contact → provider-only scalars → portal-heavy customer fields.
     */
    const HUB_FIELD_SOURCES = {
        locationSummary: ['locationSummary'],
        city: ['city'],
        county: ['county'],
        state: ['state'],
        nearbyCrossStreet: ['nearbyCrossStreet', 'nearestCrossStreet'],
        delineatedMethod: ['delineatedMethod'],
        subdivisionLot: ['subdivisionLot'],
        customerPhone: ['customerPhone'],
        customerMobile: ['customerMobile'],
        customerEmail: ['customerEmail'],
        customerLanguage: ['customerLanguage'],
        customerAddress: ['customerAddress'],
        excavatorId: ['excavatorId'],
        onsiteContactName: ['onsiteContactName'],
        onsiteContactPhone: ['onsiteContactPhone'],
        customerCity: ['customerCity'],
        customerState: ['customerState'],
        customerZip: ['customerZip'],
        workType: ['workType'],
        workActivity: ['workActivity'],
        excavationMethod: ['excavationMethod'],
        excavationSize: ['excavationSize'],
        projectOwner: ['projectOwner'],
        legalStartDate: ['legalStartDate', 'workLegalStartDate'],
        startTime: ['startTime'],
        ticketExpirationDate: ['ticketExpirationDate', 'endTime', 'workExpirationDate', 'dueDate'],
        endTime: ['endTime', 'ticketExpirationDate'],
        dueDate: ['dueDate'],
        workExpirationDate: ['workExpirationDate', 'dueDate'],
        createdBy: ['createdBy'],
        providerTicketType: ['providerTicketType'],
        categoryOfWork: ['categoryOfWork'],
        scopeOfWork: ['scopeOfWork'],
        lodgedByUserName: ['lodgedByUserName'],
        isBoring: ['isBoring'],
        isBlasting: ['isBlasting'],
        latitude: ['latitude'],
        longitude: ['longitude'],
        permit: ['permit'],
        boring: ['boring'],
        explosives: ['explosives'],
        streetSidewalk: ['streetSidewalk', 'streetSidewalkOrParkstrip', 'streetSideWalkOrParkstrip'],
        responseRequired: ['responseRequired'],
        providerPreviousRequestNumber: ['providerPreviousRequestNumber', 'ngenPreviousRequestNumber', 'previousTicketNumber'],
        /** Job / nGen enquiry id: enrichment + merged EnquirySearch; see `getUsanEnquiryIdFromTicket` in utils.js. */
        providerJobNumber: ['ngenJobNumber', 'providerJobNumber'],
        providerEnquiryStatus: ['providerEnquiryStatus'],
        providerLodgedOn: ['providerLodgedOn'],
        providerLastUpdatedTime: ['providerLastUpdatedTime'],
        providerUserReference: ['providerUserReference'],
        providerNotes: ['providerNotes'],
        providerPriority: ['providerPriority'],
        providerWorkingOnBehalf: ['providerWorkingOnBehalf'],
        providerWorkingOnBehalfOfAuth: ['providerWorkingOnBehalfOfAuth'],
        providerExcavationDepth: ['providerExcavationDepth'],
        providerPrincipalContactName: ['providerPrincipalContactName'],
        providerPrincipalContactPhone: ['providerPrincipalContactPhone'],
        /** When Core last completed POST /tickets/refresh (manual or auto selection refresh). */
        ticketLastRefreshed: ['ngenFullDetailRefreshedAt'],
    };

    /**
     * @param {object} ticket
     * @param {string} fieldId
     * @returns {*|null}
     */
    function pickTicketField(ticket, fieldId) {
        if (!ticket || !fieldId) return null;
        if (HUB_FIELD_PICKERS[fieldId]) {
            return HUB_FIELD_PICKERS[fieldId](ticket);
        }
        const paths = HUB_FIELD_SOURCES[fieldId];
        if (!paths || !paths.length) return null;
        for (let i = 0; i < paths.length; i++) {
            const v = readPath(ticket, paths[i]);
            if (v != null && String(v).trim() !== '') return v;
        }
        const legacyField = LEGACY_FIELDS[fieldId];
        if (legacyField && ticket && ticket[legacyField] != null && String(ticket[legacyField]).trim() !== '') {
            return ticket[legacyField];
        }
        return null;
    }

    window.ticketHubDisplayMap = {
        pickTicketField: pickTicketField,
        /** @deprecated use pickTicketField */
        pick: pickTicketField,
        formatTicketTypeWithUsanStatus: formatTicketTypeWithUsanStatus,
        FIELD_SOURCES: HUB_FIELD_SOURCES,
        FIELD_PICKERS: HUB_FIELD_PICKERS,
        /** @see docs/ticket-field-sources.md */
        FIELD_SOURCES_PROVENANCE: FIELD_SOURCES_PROVENANCE,
    };
})();
