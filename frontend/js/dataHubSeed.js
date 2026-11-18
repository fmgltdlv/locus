// Dev helper — seed Data Hub tabs with spread-out upload dates for pagination testing.

const DATA_HUB_SEED_PREFIX = 'dev-seed-hub-';
const DATA_HUB_SEED_GROUP_COUNT = 28;
const DATA_HUB_SEED_TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function isDataHubSeedAllowed() {
    if (typeof window !== 'undefined' && window.DATA_HUB_ALLOW_SEED === true) return true;
    if (window.authModule && typeof window.authModule.isDev === 'function' && window.authModule.isDev()) {
        return true;
    }
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    return host === 'localhost' || host === '127.0.0.1';
}

function resolveSeedOrgId() {
    if (typeof window.getCurrentOrgId === 'function') {
        const id = window.getCurrentOrgId();
        if (id != null && id !== '') return id;
    }
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        return user.organizationId || user.default_organization_id || null;
    }
    return null;
}

function seedId(kind, index) {
    return `${DATA_HUB_SEED_PREFIX}${kind}-${index}`;
}

function isSeedId(value) {
    return String(value || '').startsWith(DATA_HUB_SEED_PREFIX);
}

function isoDaysAgo(daysAgo) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
}

function dateOnlyDaysAgo(daysAgo) {
    return isoDaysAgo(daysAgo).split('T')[0];
}

function dayLabel(daysAgo) {
    if (daysAgo === 0) return 'today';
    if (daysAgo === 1) return 'yesterday';
    return `${daysAgo}d ago`;
}

function removeSeedAnnotations() {
    const mod = window.annotationStorageModule;
    if (!mod || !Array.isArray(mod.annotations)) return;
    mod.annotations = mod.annotations.filter((a) => !isSeedId(a.id));
    if (typeof mod.saveAnnotations === 'function') mod.saveAnnotations();
}

function removeSeedLayers() {
    const mod = window.annotationStorageModule;
    if (!mod || !Array.isArray(mod.savedDataLayers)) return;
    mod.savedDataLayers = mod.savedDataLayers.filter((l) => !isSeedId(l.id));
    if (typeof mod.saveDataLayers === 'function') mod.saveDataLayers();
}

function removeSeedDocuments() {
    const mod = window.documentsModule;
    if (!mod || !Array.isArray(mod.savedDocuments)) return;
    const kept = mod.savedDocuments.filter((d) => !isSeedId(d.id));
    mod.savedDocuments.length = 0;
    mod.savedDocuments.push(...kept);
    if (typeof mod.saveDocuments === 'function') mod.saveDocuments();
}

function removeSeedPhotos() {
    const mod = window.photosModule;
    if (!mod) return;
    if (Array.isArray(mod.savedPhotos)) {
        const kept = mod.savedPhotos.filter((p) => !isSeedId(p.id));
        mod.savedPhotos.length = 0;
        mod.savedPhotos.push(...kept);
    }
    if (Array.isArray(mod.photoBatches)) {
        const keptBatches = mod.photoBatches.filter((b) => !isSeedId(b.id));
        mod.photoBatches.length = 0;
        mod.photoBatches.push(...keptBatches);
    }
    if (typeof mod.savePhotos === 'function') mod.savePhotos();
    if (typeof mod.savePhotoBatches === 'function') mod.savePhotoBatches();
}

function removeSeedAerialMaps() {
    const mod = window.aerialMapsModule;
    if (!mod || !Array.isArray(mod.savedAerialMaps)) return;
    const kept = mod.savedAerialMaps.filter((m) => !isSeedId(m.id));
    mod.savedAerialMaps.length = 0;
    mod.savedAerialMaps.push(...kept);
}

function seedAnnotations(orgId) {
    const mod = window.annotationStorageModule;
    if (!mod || !Array.isArray(mod.annotations)) return 0;
    removeSeedAnnotations();
    for (let i = 0; i < DATA_HUB_SEED_GROUP_COUNT; i++) {
        mod.annotations.push({
            id: seedId('annotation', i),
            type: 'point',
            name: `Seed annotation (${dayLabel(i)})`,
            utilityType: 'Gas',
            color: '#e11d48',
            icon: 'circle',
            geometry: { type: 'Point', coordinates: [-97.7431 + i * 0.0001, 30.2672] },
            createdAt: isoDaysAgo(i),
            organizationId: orgId,
        });
    }
    if (typeof mod.saveAnnotations === 'function') mod.saveAnnotations();
    return DATA_HUB_SEED_GROUP_COUNT;
}

function seedLayers(orgId) {
    const mod = window.annotationStorageModule;
    if (!mod || !Array.isArray(mod.savedDataLayers)) return 0;
    removeSeedLayers();
    for (let i = 0; i < DATA_HUB_SEED_GROUP_COUNT; i++) {
        mod.savedDataLayers.push({
            id: seedId('layer', i),
            name: `Seed layer (${dayLabel(i)})`,
            utilityType: 'Water',
            annotations: [],
            createdAt: isoDaysAgo(i),
            organizationId: orgId,
            source: 'saved',
            isVisible: false,
            listInLayerPanel: false,
        });
    }
    if (typeof mod.saveDataLayers === 'function') mod.saveDataLayers();
    return DATA_HUB_SEED_GROUP_COUNT;
}

function seedDocuments(orgId) {
    const mod = window.documentsModule;
    if (!mod || !Array.isArray(mod.savedDocuments)) return 0;
    removeSeedDocuments();
    for (let i = 0; i < DATA_HUB_SEED_GROUP_COUNT; i++) {
        mod.savedDocuments.push({
            id: seedId('document', i),
            fileName: `seed-doc-${i}.pdf`,
            originalFileName: `seed-doc-${i}.pdf`,
            fileUrl: DATA_HUB_SEED_TINY_PNG,
            fileSize: 1024 + i,
            createdAt: isoDaysAgo(i),
            organizationId: orgId,
        });
    }
    if (typeof mod.saveDocuments === 'function') mod.saveDocuments();
    return DATA_HUB_SEED_GROUP_COUNT;
}

function seedPhotos(orgId) {
    const mod = window.photosModule;
    if (!mod || !Array.isArray(mod.savedPhotos) || !Array.isArray(mod.photoBatches)) return 0;
    removeSeedPhotos();
    for (let i = 0; i < DATA_HUB_SEED_GROUP_COUNT; i++) {
        const batchId = seedId('batch', i);
        const createdAt = isoDaysAgo(i);
        mod.photoBatches.push({
            id: batchId,
            name: `Seed upload (${dayLabel(i)})`,
            createdAt,
            organizationId: orgId,
        });
        mod.savedPhotos.push({
            id: seedId('photo', i),
            fileName: `seed-photo-${i}.jpg`,
            originalFileName: `seed-photo-${i}.jpg`,
            imageUrl: DATA_HUB_SEED_TINY_PNG,
            createdAt,
            batchId,
            organizationId: orgId,
            exifData: { gpsSource: 'None', hasGPS: false },
        });
    }
    if (typeof mod.savePhotoBatches === 'function') mod.savePhotoBatches();
    if (typeof mod.savePhotos === 'function') mod.savePhotos();
    return DATA_HUB_SEED_GROUP_COUNT;
}

function seedAerialMaps(orgId) {
    const mod = window.aerialMapsModule;
    if (!mod || !Array.isArray(mod.savedAerialMaps)) return 0;
    removeSeedAerialMaps();
    for (let i = 0; i < DATA_HUB_SEED_GROUP_COUNT; i++) {
        const createdAt = isoDaysAgo(i);
        mod.savedAerialMaps.push({
            id: seedId('aerial', i),
            name: `Seed aerial (${dayLabel(i)})`,
            url: `https://example.invalid/seed-aerial-${i}`,
            createdAt,
            capturedAt: createdAt,
            addedBy: 'dev-seed',
            organizationId: orgId,
            boundingBox: {
                type: 'Polygon',
                coordinates: [
                    [
                        [-97.75, 30.25],
                        [-97.74, 30.25],
                        [-97.74, 30.26],
                        [-97.75, 30.26],
                        [-97.75, 30.25],
                    ],
                ],
            },
        });
    }
    return DATA_HUB_SEED_GROUP_COUNT;
}

async function seedEvents(orgId) {
    if (!window.authModule || typeof window.authModule.apiRequest !== 'function') return 0;
    let created = 0;
    for (let i = 0; i < DATA_HUB_SEED_GROUP_COUNT; i++) {
        const incidentDate = dateOnlyDaysAgo(i);
        try {
            await window.authModule.apiRequest('data/reported-events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    organizationId: orgId,
                    clientLegacyId: seedId('event', i),
                    ticketNumber: `SEED-${1000 + i}`,
                    name: `Seed event (${dayLabel(i)})`,
                    incidentDate,
                    createdAt: isoDaysAgo(i),
                    description: 'Dev seed entry for Data Hub pagination testing.',
                    technicianSignature: true,
                }),
            });
            created += 1;
        } catch (e) {
            const st = e && e.status;
            if (st === 409) continue;
            console.warn('[dataHubSeed] event row failed:', e);
        }
    }
    if (window.reportedEventsStore) {
        window.reportedEventsStore.invalidate();
        try {
            await window.reportedEventsStore.ensureLoaded();
        } catch (e) {
            console.warn('[dataHubSeed] reload events:', e);
        }
    }
    return created;
}

function resetDataHubPaginationForAllViews() {
    const pag = window.dataHubPaginationModule;
    if (!pag || typeof pag.resetDataHubPage !== 'function') return;
    ['annotations', 'layers', 'photos', 'documents', 'aerialmaps', 'events'].forEach((view) => {
        pag.resetDataHubPage(view);
    });
}

/**
 * Seed sample Data Hub rows spread across many calendar days (28 groupings per tab).
 * @param {{ view?: string, replace?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, message: string, counts: Record<string, number> }>}
 */
async function seedDataHubTestData(opts) {
    const o = opts || {};
    if (!isDataHubSeedAllowed()) {
        const msg = 'Data Hub seed is only available on localhost or for dev users.';
        if (typeof window.appAlert === 'function') void window.appAlert(msg);
        return { ok: false, message: msg, counts: {} };
    }

    const orgId = resolveSeedOrgId();
    if (orgId == null) {
        const msg = 'Select an organization before seeding test data.';
        if (typeof window.appAlert === 'function') void window.appAlert(msg);
        return { ok: false, message: msg, counts: {} };
    }

    const view = o.view || null;
    const counts = {};

    if (!view || view === 'annotations') counts.annotations = seedAnnotations(orgId);
    if (!view || view === 'layers') counts.layers = seedLayers(orgId);
    if (!view || view === 'documents') counts.documents = seedDocuments(orgId);
    if (!view || view === 'photos') counts.photos = seedPhotos(orgId);
    if (!view || view === 'aerialmaps') counts.aerialmaps = seedAerialMaps(orgId);
    if (!view || view === 'events') counts.events = await seedEvents(orgId);

    resetDataHubPaginationForAllViews();

    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    } else if (typeof window.refreshDataWindow === 'function') {
        window.refreshDataWindow();
    }

    const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    const message = view
        ? `Seeded ${counts[view] || 0} test groupings in ${view} (${DATA_HUB_SEED_GROUP_COUNT} max per page is 20).`
        : `Seeded test data across Data Hub tabs (${DATA_HUB_SEED_GROUP_COUNT} groupings each; pager shows after 20).`;
    if (typeof window.appAlert === 'function') void window.appAlert(message);
    console.info('[dataHubSeed]', counts, { total });
    return { ok: true, message, counts };
}

async function clearDataHubSeedData() {
    if (!isDataHubSeedAllowed()) return { ok: false, message: 'Not allowed.' };
    removeSeedAnnotations();
    removeSeedLayers();
    removeSeedDocuments();
    removeSeedPhotos();
    removeSeedAerialMaps();
    resetDataHubPaginationForAllViews();
    if (window.dataTableRendererModule?.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
    const msg = 'Removed dev seed entries from local Data Hub tabs.';
    if (typeof window.appAlert === 'function') void window.appAlert(msg);
    return { ok: true, message: msg };
}

window.seedDataHubTestData = seedDataHubTestData;
window.clearDataHubSeedData = clearDataHubSeedData;
window.isDataHubSeedAllowed = isDataHubSeedAllowed;
