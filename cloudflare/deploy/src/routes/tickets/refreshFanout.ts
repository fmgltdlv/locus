// Ticket refresh — split from former monolithic refresh.ts (Phase 1)
import * as ticketBuilder from '../../lib/ticketBuilder.cjs';
import * as ticketSyncLane from '../../lib/ticketSyncLane.cjs';
import { persistTicketRowAfterDataChange } from '../../lib/ticketPersist.cjs';
import { runDb } from '../../lib/db.cjs';
import { hasDisplayablePolygon } from '../../lib/ticketBaseGeometry.cjs';
import { buildTicketResponseForClient, findTicketSiblingRowsByBase } from '../ticketRowHelpers.js';
import { resolveJobNumberFromTicketData } from './refreshNgen.js';
/** Org-local fields preserved when fan-out refresh merges into sibling ticket rows. */
const ORG_LOCAL_TICKET_DATA_KEYS = [
    'externalImportedToOrg',
    'shared',
    'sharedFromOrganizationId',
    'sharedSourceLabel',
    'sharedSourceOrgId',
    'devHubAggregated',
    'syncLane',
];

export function mergeRefreshedTicketDataForSibling(refreshed, previousSibling) {
    const merged = refreshed && typeof refreshed === 'object' ? { ...refreshed } : {};
    const prev = previousSibling && typeof previousSibling === 'object' ? previousSibling : {};
    for (const key of ORG_LOCAL_TICKET_DATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(prev, key)) {
            merged[key] = prev[key];
        } else {
            delete merged[key];
        }
    }
    if (prev.source && prev.source !== 'nv_api') {
        merged.source = prev.source;
    }
    if (Array.isArray(prev.webhookRevisionSuffixes) && prev.webhookRevisionSuffixes.length > 0) {
        merged.webhookRevisionSuffixes = [...prev.webhookRevisionSuffixes];
    }
    // Keep dig-site geometry when refresh payload omits it (do not NULL sibling polygon_json).
    if (!hasDisplayablePolygon(merged.polygon) && hasDisplayablePolygon(prev.polygon)) {
        merged.polygon = prev.polygon;
        if (prev.bbox != null) merged.bbox = prev.bbox;
    }
    return merged;
}

export async function upsertSiblingPacwebEnrichmentJobNumber(db, siblingRow, ticketData) {
    const jobNum = resolveJobNumberFromTicketData(ticketData);
    if (jobNum == null || !siblingRow || siblingRow.organization_id == null) return;
    const ticketBase = ticketBuilder.normalizeTicketBase(siblingRow.ticket_number) || siblingRow.ticket_number;
    if (!ticketBase) return;
    await runDb(
        db,
        `INSERT INTO ticket_pacweb_enrichment (organization_id, ticket_number, job_number, fetched_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(organization_id, ticket_number) DO UPDATE SET
           job_number = excluded.job_number,
           fetched_at = CURRENT_TIMESTAMP`,
        [siblingRow.organization_id, ticketBase, jobNum]
    );
}

export async function fanoutRefreshedTicketToSiblingRows(db, primaryRow, refreshedTicketData) {
    if (!primaryRow || primaryRow.id == null || !refreshedTicketData || typeof refreshedTicketData !== "object") {
        return { updated: 0, errors: 0, skippedLaneMismatch: 0 };
    }
    const primaryLane = ticketSyncLane.syncLaneFromTicketRow(primaryRow);
    const siblings = await findTicketSiblingRowsByBase(db, primaryRow.ticket_number);
    let updated = 0;
    let errors = 0;
    let skippedLaneMismatch = 0;
    for (const sibling of siblings) {
        if (!sibling || sibling.id == null || Number(sibling.id) === Number(primaryRow.id)) continue;
        const siblingLane = ticketSyncLane.syncLaneFromTicketRow(sibling);
        if (primaryLane !== siblingLane) {
            skippedLaneMismatch++;
            continue;
        }
        try {
            const previousSibling = await buildTicketResponseForClient(
                db,
                sibling.organization_id != null ? Number(sibling.organization_id) : null,
                sibling
            );
            const merged = mergeRefreshedTicketDataForSibling(refreshedTicketData, previousSibling);
            const stripped = ticketBuilder.stripDerivedTicketUiFields(merged);
            await persistTicketRowAfterDataChange(db, {
                ticketId: sibling.id,
                orgId: sibling.organization_id != null ? Number(sibling.organization_id) : null,
                ticketNumber: sibling.ticket_number,
                stripped,
                prev: previousSibling,
                next: merged,
                skipGeometry: true,
            });
            await upsertSiblingPacwebEnrichmentJobNumber(db, sibling, stripped);
            updated++;
        } catch (e) {
            errors++;
            console.warn('[ticketRefresh] sibling fanout failed:', {
                sourceTicketId: primaryRow.id,
                siblingTicketId: sibling.id,
                siblingOrgId: sibling.organization_id,
                error: e && e.message ? e.message : String(e),
            });
        }
    }
    if (skippedLaneMismatch > 0) {
        console.log("[ticketRefresh] sibling fanout skipped (sync_lane mismatch)", {
            sourceTicketId: primaryRow.id,
            skippedLaneMismatch,
            primaryLane,
        });
    }
    return { updated, errors, skippedLaneMismatch };
}
