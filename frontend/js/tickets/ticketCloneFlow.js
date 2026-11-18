/**
 * Clone Ticket — opens create-ticket wizard with fields copied from an existing ticket.
 */
(function (global) {
    'use strict';

    function pickField(ticket, keys) {
        if (!ticket) return '';
        const list = Array.isArray(keys) ? keys : [keys];
        for (let i = 0; i < list.length; i += 1) {
            const v = ticket[list[i]];
            if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        return '';
    }

    function hubField(ticket, providerKey, fallbackKeys) {
        if (typeof global.hubMappedField === 'function') {
            const v = global.hubMappedField(ticket, providerKey);
            if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        return pickField(ticket, fallbackKeys);
    }

    function hubPick(ticket, fieldId) {
        const dm = global.ticketHubDisplayMap;
        if (dm && typeof dm.pickTicketField === 'function') {
            const v = dm.pickTicketField(ticket, fieldId);
            if (v != null && String(v).trim() !== '') return String(v).trim();
        }
        return '';
    }

    function ticketLabel(ticket) {
        if (!ticket) return '—';
        const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        return tn || (ticket.id != null ? String(ticket.id) : '—');
    }

    function mapTicketTypeFromTicket(ticket) {
        const raw =
            pickField(ticket, ['ngenTicketType', 'providerTicketType', 'ticketType']) ||
            hubPick(ticket, 'providerTicketType');
        const s = String(raw || '').toLowerCase();
        if (s.indexOf('short') !== -1) return 'Short';
        if (s.indexOf('emergency') !== -1) return 'Emergency';
        return 'Normal';
    }

    function emptySharedBlob() {
        return {
            jobName: '',
            ticketType: 'Normal',
            workCategoryId: '',
            workActivityId: '',
            excavationMethod: '',
            horizontalBoring: '',
            explosives: '',
            streetSidewalkParkstrip: '',
            permitExcavation: '',
            areaPreMarked: '',
            startDateYmd: '',
            startTimeHm: '',
            projectOwnerTypeId: '',
            projectOwnerAuthId: '',
            principalName: '',
            principalMobile: '',
        };
    }

    /**
     * @param {object} ticket
     * @param {boolean} copyPolygon
     * @returns {{ shared: object, digSites?: object[] }}
     */
    function buildWizardPrefillFromTicket(ticket, copyPolygon) {
        const shared = emptySharedBlob();
        if (!ticket) return { shared };

        shared.jobName = hubField(ticket, 'jobName', ['ngenUserReference', 'jobName', 'userReference']);
        shared.principalName = pickField(ticket, [
            'ngenPrincipalContactName',
            'principalContactName',
            'providerPrincipalContactName',
        ]);
        shared.principalMobile = pickField(ticket, [
            'ngenPrincipalContactPhone',
            'principalContactPhone',
            'providerPrincipalContactPhone',
        ]);
        shared.ticketType = mapTicketTypeFromTicket(ticket);

        const prefill = { shared };
        if (!copyPolygon) return prefill;

        const polygon =
            ticket.polygon && ticket.polygon.type === 'Polygon' ? ticket.polygon : null;
        const scope =
            hubPick(ticket, 'scopeOfWork') ||
            pickField(ticket, ['scopeOfWork', 'workDescription', 'ticketScope']);
        const cross =
            hubPick(ticket, 'nearbyCrossStreet') ||
            pickField(ticket, ['nearestCrossStreet', 'nearbyCrossStreet']);
        const street =
            pickField(ticket, ['street', 'address']) ||
            hubPick(ticket, 'locationSummary') ||
            pickField(ticket, ['locationSummary']);

        prefill.digSites = [
            {
                polygonGeoJson: polygon,
                scope: scope,
                nearestCrossStreet: cross,
                address: {
                    street: street,
                    city: pickField(ticket, ['city', 'customerCity']) || hubPick(ticket, 'city'),
                    state: pickField(ticket, ['state', 'customerState']) || hubPick(ticket, 'state'),
                    zip: pickField(ticket, ['zip', 'customerZip']) || hubPick(ticket, 'zip'),
                    county: pickField(ticket, ['county']) || hubPick(ticket, 'county'),
                },
                reverseGeocodeRow: null,
                geocodeSummary: '',
                geocodeMeta: '',
                geocodeStatusText: '',
                geocodeStatusError: false,
                uiCollapsed: false,
            },
        ];
        return prefill;
    }

    function mergeSharedPrefill(base, enriched) {
        if (!enriched || typeof enriched !== 'object') return base;
        const out = Object.assign({}, base || emptySharedBlob());
        Object.keys(out).forEach(function (k) {
            const v = enriched[k];
            if (v != null && String(v).trim() !== '') out[k] = String(v).trim();
        });
        return out;
    }

    function mergeDigSitePrefill(baseSites, enrichedSites) {
        if (!Array.isArray(enrichedSites) || !enrichedSites.length) return baseSites;
        const base = Array.isArray(baseSites) && baseSites.length ? baseSites[0] : {};
        const en = enrichedSites[0] || {};
        const merged = Object.assign({}, base);
        if (en.polygonGeoJson && en.polygonGeoJson.type === 'Polygon') {
            merged.polygonGeoJson = en.polygonGeoJson;
        }
        if (en.scope != null && String(en.scope).trim()) merged.scope = String(en.scope).trim();
        if (en.nearestCrossStreet != null && String(en.nearestCrossStreet).trim()) {
            merged.nearestCrossStreet = String(en.nearestCrossStreet).trim();
        }
        if (en.address && typeof en.address === 'object') {
            merged.address = Object.assign({}, base.address || {}, en.address);
        }
        return [merged];
    }

    async function enrichPrefillFromApi(orgId, ticketNumber, copyPolygon, prefill) {
        if (!global.authModule || typeof global.authModule.apiRequest !== 'function') return prefill;
        try {
            const data = await global.authModule.apiRequest('tickets/clone-wizard-prefill', {
                method: 'POST',
                body: JSON.stringify({
                    organizationId: Number(orgId),
                    ticketNumber: ticketNumber,
                    copyPolygon: copyPolygon,
                }),
            });
            if (!data || data.clientOnly) return prefill;
            const out = {
                shared: mergeSharedPrefill(prefill.shared, data.shared),
                digSites: copyPolygon
                    ? mergeDigSitePrefill(prefill.digSites, data.digSites)
                    : prefill.digSites,
            };
            return out;
        } catch (e) {
            return prefill;
        }
    }

    async function openFromTicket(ticket) {
        if (typeof global.isTicketRenewalHubEnabled !== 'function' || !global.isTicketRenewalHubEnabled()) {
            if (typeof global.appAlert === 'function') {
                void global.appAlert('Ticket actions are not enabled.');
            }
            return;
        }
        if (!ticket || ticket.shared) {
            if (typeof global.appAlert === 'function') {
                void global.appAlert('Clone is not available on shared tickets.');
            }
            return;
        }
        if (
            global.offlineModule &&
            global.offlineModule.guardOfflineAction &&
            global.offlineModule.guardOfflineAction('Ticket actions require an internet connection.')
        ) {
            return;
        }

        const orgId =
            global.orgSelectorModule && typeof global.orgSelectorModule.getCurrentOrgId === 'function'
                ? global.orgSelectorModule.getCurrentOrgId()
                : null;
        if (orgId == null || orgId === '') {
            if (typeof global.appAlert === 'function') void global.appAlert('Select an organization first.');
            return;
        }

        const tn = ticket.ticketNumber != null ? String(ticket.ticketNumber).trim() : '';
        if (!tn) {
            if (typeof global.appAlert === 'function') void global.appAlert('Ticket number is missing.');
            return;
        }

        let copyPolygon = false;
        if (typeof global.appChoice === 'function') {
            const picked = await global.appChoice(
                'Copy the existing ticket polygon, address, and scope of work into the new ticket?\n\n' +
                    'Yes — copy polygon, address, and scope.\n' +
                    'No — copy shared ticket details only (draw a new dig site).',
                {
                    title: 'Copy ticket polygon?',
                    choices: [
                        { id: 'yes', label: 'Yes, copy polygon', variant: 'primary' },
                        { id: 'no', label: 'No, shared details only', variant: 'secondary' },
                    ],
                    cancelText: 'Cancel',
                }
            );
            if (picked == null) return;
            copyPolygon = picked === 'yes';
        } else if (typeof global.appConfirm === 'function') {
            copyPolygon = await global.appConfirm(
                'Copy the existing ticket polygon, address, and scope of work?',
                {
                    title: 'Copy ticket polygon?',
                    confirmText: 'Yes, copy polygon',
                    cancelText: 'No, shared only',
                }
            );
        }

        let prefill = buildWizardPrefillFromTicket(ticket, copyPolygon);
        prefill = await enrichPrefillFromApi(orgId, tn, copyPolygon, prefill);

        const wizard = global.createTicketWizardModule;
        if (wizard && typeof wizard.openCloneFromTicket === 'function') {
            return wizard.openCloneFromTicket(ticket, {
                copyPolygon: copyPolygon,
                prefill: prefill,
                sourceLabel:
                    'Cloned from ticket ' +
                    ticketLabel(ticket) +
                    ' — review all steps before submitting a new ticket.',
            });
        }
        if (typeof global.appAlert === 'function') {
            void global.appAlert('Create ticket wizard is not available.');
        }
    }

    global.ticketCloneFlow = {
        openFromTicket: openFromTicket,
        buildWizardPrefillFromTicket: buildWizardPrefillFromTicket,
    };
})(typeof window !== 'undefined' ? window : globalThis);
