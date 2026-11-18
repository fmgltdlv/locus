/**
 * tableServiceRequestActions.js — split from tableActions.js (Phase F4).
 * Service request / site documentation.
 */

/** @type {object[]} Tickets pending for the open service request modal. */
let pendingServiceRequestTickets = [];
/** Prevents duplicate POSTs from double-submit / Enter spam. */
let serviceRequestSubmitInFlight = false;

function serviceRequestTicketValue(ticket, keys) {
    if (!ticket) return '';
    for (const key of keys) {
        const value = ticket[key];
        if (value != null && String(value).trim() !== '') {
            return String(value).trim();
        }
    }
    return '';
}

function serviceRequestTicketLabel(ticket) {
    return serviceRequestTicketValue(ticket, ['ticketNumber', 'requestNumber', 'id']) || 'Unknown';
}

function buildTicketSummaryForServiceRequest(ticket) {
    if (!ticket) return null;
    const summary = {};
    const fields = [
        ['ticketNumber', ['ticketNumber', 'requestNumber']],
        ['id', ['id']],
        ['ticketRevision', ['ticketRevision', 'revision']],
        ['organizationId', ['organizationId', 'organization_id']],
        ['status', ['status']],
        ['jobName', ['jobName', 'projectName', 'name']],
        ['address', ['address', 'digSiteAddress', 'locationSummary']],
        ['city', ['city', 'town']],
        ['county', ['county']],
        ['workDescription', ['workDescription', 'description']],
        ['workStart', ['startTime', 'legalStartDate', 'startDate']],
        ['ticketExpiration', ['ticketExpirationDate', 'endTime', 'expirationDate']]
    ];
    for (const [outKey, keys] of fields) {
        const value = serviceRequestTicketValue(ticket, keys);
        if (value) summary[outKey] = value;
    }
    // Prefer live org context when ticket omits organizationId
    if (!summary.organizationId && window.authModule && typeof window.authModule.getCurrentOrganizationId === 'function') {
        const oid = window.authModule.getCurrentOrganizationId();
        if (oid != null && Number.isFinite(Number(oid))) summary.organizationId = Number(oid);
    } else if (summary.organizationId != null) {
        summary.organizationId = Number(summary.organizationId);
    }
    return Object.keys(summary).length ? summary : null;
}

function buildServiceRequestNoteJson(services, userNote, ticket) {
    const ticketSummary = buildTicketSummaryForServiceRequest(ticket);
    const serviceRequested =
        Array.isArray(services) && services.length === 1
            ? services[0]
            : Array.isArray(services) && services.includes('site_documentation')
              ? 'site_documentation'
              : Array.isArray(services) && services[0]
                ? services[0]
                : 'site_documentation';
    const feed = {
        source: 'manual',
        serviceRequested,
        ticketOrganizationId:
            ticketSummary && ticketSummary.organizationId != null
                ? Number(ticketSummary.organizationId)
                : null,
        ticketNumber:
            ticketSummary && ticketSummary.ticketNumber
                ? String(ticketSummary.ticketNumber)
                : '',
        ticketRevision:
            ticketSummary && ticketSummary.ticketRevision
                ? String(ticketSummary.ticketRevision)
                : null,
        acknowledgeReason: null
    };
    return JSON.stringify({
        v: 1,
        feed,
        services: Array.isArray(services) ? services.slice() : [],
        userNote: userNote && String(userNote).trim() ? String(userNote).trim() : '',
        ticket: ticketSummary
    });
}

function updateServiceRequestContextLabel(tickets) {
    const el = document.getElementById('serviceRequestContext');
    if (!el) return;
    const list = Array.isArray(tickets) ? tickets.filter(Boolean) : [];
    if (list.length === 0) {
        el.textContent = '';
        return;
    }
    if (list.length === 1) {
        el.textContent = `Requesting for ticket ${serviceRequestTicketLabel(list[0])}.`;
        return;
    }
    el.textContent = `Requesting for ${list.length} tickets.`;
}

function getSelectedServiceTypesFromForm() {
    const services = [];
    const siteDoc = document.getElementById('serviceTypeSiteDocumentation');
    const privateLoc = document.getElementById('serviceTypePrivateLocating');
    if (siteDoc && siteDoc.checked) services.push('site_documentation');
    if (privateLoc && privateLoc.checked) services.push('private_locating');
    return services;
}

function storedServiceTypeForSelection(services) {
    if (!Array.isArray(services) || services.length === 0) return '';
    if (services.length === 1) return services[0];
    return 'multi';
}

// Open service request modal (requires at least one ticket)
function openServiceRequestModal(tickets) {
    if (window.LOCUS_HIDE_SITE_DOCUMENTATION === true) return;
    const list = Array.isArray(tickets) ? tickets.filter(Boolean) : (tickets ? [tickets] : []);
    if (list.length === 0) {
        if (typeof appAlert === 'function') {
            void appAlert('Select at least one ticket to request services.');
        }
        return;
    }

    pendingServiceRequestTickets = list;
    setServiceRequestSubmitBusy(false);

    const form = document.getElementById('serviceRequestForm');
    if (form) form.reset();

    const siteDoc = document.getElementById('serviceTypeSiteDocumentation');
    const privateLoc = document.getElementById('serviceTypePrivateLocating');
    if (siteDoc) siteDoc.checked = true;
    if (privateLoc) privateLoc.checked = false;

    updateServiceRequestContextLabel(list);

    const modal = document.getElementById('serviceRequestModal');
    if (modal) {
        modal.style.display = 'flex';
        modal.style.zIndex = '70000'; // Ensure it's above data window
        document.body.style.overflow = 'hidden';
    }
}

function setServiceRequestSubmitBusy(isBusy) {
    serviceRequestSubmitInFlight = Boolean(isBusy);
    const form = document.getElementById('serviceRequestForm');
    const submitBtn = form && form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = serviceRequestSubmitInFlight;
    const cancelBtn = form && form.querySelector('button[type="button"]');
    if (cancelBtn) cancelBtn.disabled = serviceRequestSubmitInFlight;
}

// Close service request modal
function closeServiceRequestModal() {
    if (serviceRequestSubmitInFlight) return;

    pendingServiceRequestTickets = [];
    updateServiceRequestContextLabel([]);
    setServiceRequestSubmitBusy(false);

    const modal = document.getElementById('serviceRequestModal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = '';
        
        // Reset form
        const form = document.getElementById('serviceRequestForm');
        if (form) {
            form.reset();
        }
    }
}

async function postServiceRequest(serviceType, note, organizationId) {
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        throw new Error('You must be logged in to submit a service request.');
    }
    if (typeof window.authModule.apiRequest !== 'function') {
        throw new Error('Service request API is unavailable.');
    }

    const apiBase = window.authModule.API_BASE || window.API_BASE;
    if (!apiBase) {
        throw new Error('Service request API base URL is not configured.');
    }

    const payload = {
        serviceType,
        note: note && String(note).trim() ? String(note).trim() : null
    };
    const oid = organizationId != null ? Number(organizationId) : null;
    if (oid != null && Number.isFinite(oid) && oid > 0) {
        payload.organizationId = oid;
    } else if (
        window.authModule &&
        typeof window.authModule.getCurrentOrganizationId === 'function'
    ) {
        const activeOrgId = window.authModule.getCurrentOrganizationId();
        if (activeOrgId != null) payload.organizationId = activeOrgId;
    }

    return window.authModule.apiRequest(`${apiBase}/service-requests`, {
        method: 'POST',
        body: JSON.stringify(payload)
    });
}

/** Opens the service request modal for a single ticket (no auto-submit). */
function requestSiteDocumentationForTicket(ticket) {
    if (!ticket) {
        throw new Error('No ticket selected.');
    }
    openServiceRequestModal([ticket]);
}

/** Opens the service request modal for multiple tickets (no auto-submit). */
function requestSiteDocumentationForTickets(tickets) {
    const list = Array.isArray(tickets) ? tickets.filter(Boolean) : [];
    if (list.length === 0) {
        throw new Error('No tickets selected.');
    }
    openServiceRequestModal(list);
}

// Submit service request
async function submitServiceRequest(event) {
    if (window.LOCUS_HIDE_SITE_DOCUMENTATION === true) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        await appAlert('Site documentation requests are turned off.');
        return;
    }
    event.preventDefault();

    if (serviceRequestSubmitInFlight) return;
    
    if (!window.authModule || !window.authModule.isAuthenticated()) {
        await appAlert('You must be logged in to submit a service request.');
        return;
    }

    const tickets = Array.isArray(pendingServiceRequestTickets)
        ? pendingServiceRequestTickets.filter(Boolean)
        : [];
    if (tickets.length === 0) {
        await appAlert('No ticket selected. Close and open Request Services from a ticket.');
        return;
    }
    
    const services = getSelectedServiceTypesFromForm();
    if (services.length === 0) {
        await appAlert('Please select at least one service.');
        return;
    }

    const userNote = document.getElementById('serviceNote')?.value || '';
    const serviceType = storedServiceTypeForSelection(services);

    setServiceRequestSubmitBusy(true);
    try {
        const results = await Promise.allSettled(
            tickets.map(ticket => {
                const summary = buildTicketSummaryForServiceRequest(ticket);
                return postServiceRequest(
                    serviceType,
                    buildServiceRequestNoteJson(services, userNote, ticket),
                    summary && summary.organizationId != null ? summary.organizationId : null
                );
            })
        );
        const failed = results
            .map((result, index) => ({ result, ticket: tickets[index] }))
            .filter(item => item.result.status === 'rejected')
            .map(item => ({
                ticket: item.ticket,
                error: item.result.reason && item.result.reason.message
                    ? item.result.reason.message
                    : 'Request failed'
            }));
        const succeeded = tickets.length - failed.length;

        // Keep the modal open on total failure so the user can retry without re-entering notes.
        if (succeeded > 0) {
            serviceRequestSubmitInFlight = false;
            closeServiceRequestModal();
        }

        if (tickets.length === 1) {
            if (failed.length > 0) {
                await appAlert(`Error submitting service request: ${failed[0].error}`);
            } else {
                await appAlert('Service request submitted successfully! We will get back to you soon.');
            }
            return;
        }

        if (failed.length > 0) {
            const failedLines = failed
                .map(item => `${serviceRequestTicketLabel(item.ticket)}: ${item.error}`)
                .join('\n');
            const message =
                succeeded > 0
                    ? `Submitted ${succeeded} service request(s). Failed ${failed.length}:\n${failedLines}`
                    : `No service requests were submitted. Failed ${failed.length}:\n${failedLines}`;
            await appAlert(message);
        } else {
            await appAlert(`Submitted ${succeeded} service request(s).`);
        }
    } catch (error) {
        console.error('Error submitting service request:', error);
        await appAlert(`Error submitting service request: ${error.message || 'Please try again later.'}`);
    } finally {
        if (serviceRequestSubmitInFlight) {
            setServiceRequestSubmitBusy(false);
        }
    }
}

// Export service request functions
window.openServiceRequestModal = openServiceRequestModal;
window.closeServiceRequestModal = closeServiceRequestModal;
window.submitServiceRequest = submitServiceRequest;
window.requestSiteDocumentationForTicket = requestSiteDocumentationForTicket;
window.requestSiteDocumentationForTickets = requestSiteDocumentationForTickets;
