import { Hono } from "hono";
import { getDatabase } from "../database.js";
import { authMiddleware } from "../auth.js";
import { buildExpressReq, expressReqResMiddleware, jsonBodyMiddleware, ResShim } from "../expressCompat.js";
import type { Env } from "../types.js";
import {
    parseBbox,
    parsePublicTimeRange,
    userCanAccessPublicCatalog,
    getPublicTicketsInBbox,
    getPublicMediaInBbox,
    getPublicLayersInBbox,
    getPublicAerialMapsInBbox,
    publicAerialRowToClient,
} from "../lib/publicShareQuery.cjs";
import { buildPublicMapTicketForClient } from "./ticketRowHelpers.js";
import { computeWorkflowStatusForPartnerTicket } from "./computeWorkflowStatus.js";
import { getRow } from "../lib/db.cjs";
import { getWorkflowAckCompliancePolicy, DEFAULT_EXPIRING_SOON_DAYS } from "../lib/workflowAckCompliance.cjs";

const publicRoutes = new Hono<{ Bindings: Env; Variables: { user: unknown; jsonBody: unknown; expressRes: ResShim } }>() as any;
publicRoutes.use("*", jsonBodyMiddleware);
publicRoutes.use("*", authMiddleware);
publicRoutes.use("*", expressReqResMiddleware);

function publicAnnotationRowToClient(r) {
    let geom = null;
    try {
        geom = typeof r.geometry === "string" ? JSON.parse(String(r.geometry)) : r.geometry;
    } catch (_) {
        geom = null;
    }
    return {
        id: r.ann_id,
        type: r.annotation_type || undefined,
        geometry: geom,
        name: r.name || "",
        color: r.color || undefined,
        icon: r.icon || undefined,
        utilityType: r.utility_type || "",
        documentRef: r.document_ref || "",
        linePattern: r.line_pattern || undefined,
        originalName: r.original_name || undefined,
        createdAt: r.created_at || undefined,
    };
}

function publicLayerRowToClient(layer, annotations) {
    return {
        id: layer.layer_id,
        name: layer.name || "",
        originalName: layer.original_name || layer.name || "",
        annotations,
        utilityType: layer.utility_type || "",
        createdAt: layer.created_at || undefined,
        isVisible: Number(layer.is_visible) !== 0,
        listInLayerPanel: Number(layer.list_in_layer_panel) !== 0,
        source: layer.source || undefined,
        organizationId: layer.organization_id,
    };
}

function mapPublicMediaRow(row) {
    return {
        id: row.id,
        fileName: row.file_name,
        fileType: row.file_type,
        fileSize: row.file_size,
        thumbnailUrl: row.thumbnail_path ? `/api/data/media/${row.id}/thumbnail` : undefined,
        mimeType: row.mime_type,
        createdAt: row.created_at,
        latitude: row.latitude,
        longitude: row.longitude,
        hasGps: row.has_gps === 1,
        isPublic: true,
    };
}

/** Area search for public catalog org: tickets (all from opted-in orgs), photos/layers (is_public only). */
publicRoutes.get("/map", async (c) => {
    const req = buildExpressReq(c);
    const res = c.get("expressRes") as ResShim;
    const db = getDatabase();
    const userId = req.user.id;

    if (!(await userCanAccessPublicCatalog(db, userId))) {
        return res.status(403).json({
            error: "Your organization must enable public sharing before you can view public data.",
        });
    }

    const bbox = parseBbox(req.query.bbox != null ? String(req.query.bbox) : "");
    if (!bbox) {
        return res.status(400).json({ error: "bbox query is required (minLng,minLat,maxLng,maxLat)" });
    }

    const typesRaw = req.query.types != null ? String(req.query.types) : "tickets,photos,layers,aerial";
    const types = new Set(
        typesRaw
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean)
    );
    if (!types.size) types.add("tickets");

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "500"), 10) || 500, 1), 500);
    const timeRange = parsePublicTimeRange(req.query.from, req.query.to);

    try {
        const out = { tickets: [], photos: [], layers: [], aerial: [] };

        if (types.has("tickets")) {
            const ticketHits = await getPublicTicketsInBbox(db, bbox, limit, timeRange);
            const expiringSoonByOrg = new Map();
            const uniqueOrgIds = [
                ...new Set(
                    ticketHits
                        .map((hit) => (hit && hit.sourceOrgId != null ? Number(hit.sourceOrgId) : NaN))
                        .filter((id) => Number.isFinite(id))
                ),
            ];
            await Promise.all(
                uniqueOrgIds.map(async (orgId) => {
                    const orgRow = await getRow(db, "SELECT settings FROM organizations WHERE id = ?", [orgId]);
                    const policy = getWorkflowAckCompliancePolicy(orgRow);
                    expiringSoonByOrg.set(
                        orgId,
                        Number.isFinite(Number(policy.expiringSoonDays))
                            ? Number(policy.expiringSoonDays)
                            : DEFAULT_EXPIRING_SOON_DAYS
                    );
                })
            );
            out.tickets = ticketHits
                .map((hit) => {
                    const t = buildPublicMapTicketForClient(hit.sourceOrgId, hit.row, hit) as Record<string, unknown>;
                    const ownerOrgId = hit && hit.sourceOrgId != null ? Number(hit.sourceOrgId) : NaN;
                    const expiringSoonDays = Number.isFinite(ownerOrgId)
                        ? expiringSoonByOrg.get(ownerOrgId) ?? DEFAULT_EXPIRING_SOON_DAYS
                        : DEFAULT_EXPIRING_SOON_DAYS;
                    t.expiringSoonDays = expiringSoonDays;
                    t.computedWorkflowStatus = computeWorkflowStatusForPartnerTicket(t, { expiringSoonDays });
                    t.status = t.computedWorkflowStatus;
                    return t;
                })
                .filter(Boolean);
        }

        if (types.has("photos")) {
            const fileType = req.query.type != null ? String(req.query.type) : null;
            const mediaHits = await getPublicMediaInBbox(db, bbox, fileType || null, limit, timeRange);
            out.photos = mediaHits.map((hit) => ({
                ...mapPublicMediaRow(hit.row),
                shared: true,
                sharedFromOrganizationId: hit.sourceOrgId,
                sharedSourceLabel: hit.displayLabel,
                readOnly: true,
            }));
        }

        if (types.has("layers")) {
            const layerHits = await getPublicLayersInBbox(db, bbox, Math.min(limit, 100), timeRange);
            out.layers = layerHits.map((hit) => ({
                ...publicLayerRowToClient(
                    hit.layer,
                    (hit.features || []).map((f) => publicAnnotationRowToClient(f))
                ),
                shared: true,
                sharedFromOrganizationId: hit.sourceOrgId,
                sharedSourceLabel: hit.displayLabel,
                readOnly: true,
            }));
        }

        if (types.has("aerial") || types.has("aerialmaps") || types.has("drone")) {
            const aerialHits = await getPublicAerialMapsInBbox(db, bbox, Math.min(limit, 100), timeRange);
            out.aerial = aerialHits.map((hit) => ({
                ...publicAerialRowToClient(hit.row),
                readOnly: true,
            }));
        }

        return res.json(out);
    } catch (e) {
        console.error("GET /public/map:", e);
        return res.status(500).json({ error: "Failed to fetch public map data" });
    }
});

export { publicRoutes };
