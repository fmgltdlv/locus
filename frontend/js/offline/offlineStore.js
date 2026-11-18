/**
 * IndexedDB persistence for PWA offline mode (database: locus-offline).
 */
(function () {
    'use strict';

    const DB_NAME = 'locus-offline';
    const DB_VERSION = 3;
    const BLOB_STORES = ['photoBlobs', 'pendingUploads', 'usanDocs'];

    const STORE_NAMES = [
        'ticketsByOrg',
        'ticketNotes',
        'ticketPolygons',
        'photoMeta',
        'photoBlobs',
        'pendingUploads',
        'pendingNotes',
        'syncMeta',
        'assignedTicketDetail',
        'usanDocs',
    ];

    let dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('IndexedDB unavailable'));
                return;
            }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
            req.onupgradeneeded = (ev) => {
                const db = ev.target.result;
                for (const name of STORE_NAMES) {
                    if (!db.objectStoreNames.contains(name)) {
                        db.createObjectStore(name);
                    }
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
        return dbPromise;
    }

    async function withStore(storeName, mode, fn) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            let result;
            try {
                result = fn(store);
            } catch (e) {
                reject(e);
                return;
            }
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
    }

    function reqToPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
        });
    }

    async function get(storeName, key) {
        const k = String(key);
        return withStore(storeName, 'readonly', (store) => {
            const r = store.get(k);
            return reqToPromise(r);
        });
    }

    async function put(storeName, key, value) {
        const k = String(key);
        return withStore(storeName, 'readwrite', (store) => {
            const r = store.put(value, k);
            return reqToPromise(r);
        });
    }

    async function remove(storeName, key) {
        const k = String(key);
        return withStore(storeName, 'readwrite', (store) => {
            const r = store.delete(k);
            return reqToPromise(r);
        });
    }

    async function getAllKeys(storeName) {
        return withStore(storeName, 'readonly', (store) => reqToPromise(store.getAllKeys()));
    }

    async function getAll(storeName) {
        return withStore(storeName, 'readonly', (store) => reqToPromise(store.getAll()));
    }

    function ticketTtlMs() {
        return window.offlineCacheTtl && window.offlineCacheTtl.TICKET_TTL_MS
            ? window.offlineCacheTtl.TICKET_TTL_MS
            : 7 * 24 * 60 * 60 * 1000;
    }

    function photoTtlMs() {
        return window.offlineCacheTtl && window.offlineCacheTtl.PHOTO_TTL_MS
            ? window.offlineCacheTtl.PHOTO_TTL_MS
            : 14 * 24 * 60 * 60 * 1000;
    }

    function usanDocTtlMs() {
        return window.offlineCacheTtl && window.offlineCacheTtl.USAN_DOC_TTL_MS
            ? window.offlineCacheTtl.USAN_DOC_TTL_MS
            : 30 * 24 * 60 * 60 * 1000;
    }

    function isRowExpired(cachedAt, ttlMs) {
        if (window.offlineCacheTtl && typeof window.offlineCacheTtl.isExpired === 'function') {
            return window.offlineCacheTtl.isExpired(cachedAt, ttlMs);
        }
        if (cachedAt == null || !Number.isFinite(cachedAt)) return true;
        return Date.now() - cachedAt >= ttlMs;
    }

    async function getWithExpiry(storeName, key, tsField, ttlMs) {
        const row = await get(storeName, key);
        if (!row) return null;
        const ts = row[tsField];
        if (isRowExpired(ts, ttlMs)) {
            await remove(storeName, key);
            return null;
        }
        return row;
    }

    function orgKey(orgId) {
        return orgId != null && orgId !== '' ? String(orgId) : '_none';
    }

    function ticketNotesKey(orgId, ticketNumber) {
        return `${orgKey(orgId)}:${String(ticketNumber || '').trim()}`;
    }

    function assignedDetailKey(orgId, ticketNumber) {
        return ticketNotesKey(orgId, ticketNumber);
    }

    function ticketPolygonKey(orgId, ticketBase) {
        return `${orgKey(orgId)}:poly:${String(ticketBase || '').trim().toUpperCase()}`;
    }

    function usanDocFullHistoryKey(orgId, ticketBase) {
        return `${orgKey(orgId)}:${String(ticketBase || '').trim()}:full-history`;
    }

    function usanDocConfirmationKey(orgId, ticketBase, revision) {
        return `${orgKey(orgId)}:${String(ticketBase || '').trim()}:confirmation:${String(revision || '').trim()}`;
    }

    async function putUsanDoc(key, blob, meta) {
        if (!key || !blob) return;
        const m = meta && typeof meta === 'object' ? meta : {};
        await put('usanDocs', String(key), {
            blob,
            kind: m.kind || null,
            revision: m.revision != null ? String(m.revision) : null,
            requestNumber: m.requestNumber != null ? String(m.requestNumber) : null,
            enquiryId: m.enquiryId != null ? String(m.enquiryId) : null,
            status: m.status != null ? String(m.status) : null,
            cachedAt: Date.now(),
        });
    }

    async function getUsanDoc(key) {
        const row = await getWithExpiry('usanDocs', String(key), 'cachedAt', usanDocTtlMs());
        return row && row.blob ? row : null;
    }

    async function listUsanDocKeysWithPrefix(prefix) {
        const keys = await getAllKeys('usanDocs');
        const p = String(prefix || '');
        return (keys || []).map(String).filter((k) => k.startsWith(p));
    }

    async function putTicketsByOrg(orgId, payload) {
        await put('ticketsByOrg', orgKey(orgId), payload);
        const meta = (await get('syncMeta', orgKey(orgId))) || {};
        meta.lastTicketSyncAt = Date.now();
        await put('syncMeta', orgKey(orgId), meta);
    }

    async function getTicketsByOrg(orgId) {
        return getWithExpiry('ticketsByOrg', orgKey(orgId), 'loadedAt', ticketTtlMs());
    }

    async function putTicketPolygon(orgId, ticketBase, polygonPayload) {
        const base = String(ticketBase || '').trim();
        if (!base || !polygonPayload || polygonPayload.polygon == null) return;
        await put('ticketPolygons', ticketPolygonKey(orgId, base), {
            polygon: polygonPayload.polygon,
            bbox: polygonPayload.bbox || null,
            pin: polygonPayload.pin || null,
            ticketNumber: polygonPayload.ticketNumber || null,
            cachedAt: Date.now(),
        });
    }

    async function getTicketPolygon(orgId, ticketBase) {
        return getWithExpiry('ticketPolygons', ticketPolygonKey(orgId, ticketBase), 'cachedAt', ticketTtlMs());
    }

    async function putTicketNotes(orgId, ticketNumber, notes, reviewRequired) {
        await put('ticketNotes', ticketNotesKey(orgId, ticketNumber), {
            notes: Array.isArray(notes) ? notes : [],
            reviewRequired: !!reviewRequired,
            cachedAt: Date.now(),
        });
    }

    async function getTicketNotes(orgId, ticketNumber) {
        return getWithExpiry('ticketNotes', ticketNotesKey(orgId, ticketNumber), 'cachedAt', ticketTtlMs());
    }

    async function putAssignedTicketDetail(orgId, ticketNumber, ticket, hydrationLevel) {
        await put('assignedTicketDetail', assignedDetailKey(orgId, ticketNumber), {
            ticket,
            hydratedAt: Date.now(),
            hydrationLevel: hydrationLevel || 'db',
        });
    }

    async function getAssignedTicketDetail(orgId, ticketNumber) {
        return getWithExpiry('assignedTicketDetail', assignedDetailKey(orgId, ticketNumber), 'hydratedAt', ticketTtlMs());
    }

    async function putPhotoMeta(orgId, photos, batches) {
        await put('photoMeta', orgKey(orgId), {
            photos: Array.isArray(photos) ? photos : [],
            batches: Array.isArray(batches) ? batches : [],
            cachedAt: Date.now(),
        });
        const meta = (await get('syncMeta', orgKey(orgId))) || {};
        meta.lastPhotoSyncAt = Date.now();
        await put('syncMeta', orgKey(orgId), meta);
    }

    async function getPhotoMeta(orgId) {
        return getWithExpiry('photoMeta', orgKey(orgId), 'cachedAt', photoTtlMs());
    }

    async function putPhotoBlob(blobKey, blob, kind) {
        await put('photoBlobs', String(blobKey), {
            blob,
            kind: kind === 'full' ? 'full' : 'thumb',
            cachedAt: Date.now(),
        });
    }

    async function getPhotoBlob(blobKey) {
        const row = await getWithExpiry('photoBlobs', String(blobKey), 'cachedAt', photoTtlMs());
        return row && row.blob ? row : null;
    }

    async function estimateBlobBytes() {
        let total = 0;
        for (const storeName of BLOB_STORES) {
            const all = await getAll(storeName);
            for (const row of all) {
                if (row && row.blob && typeof row.blob.size === 'number') {
                    total += row.blob.size;
                } else if (row && row.jpegBlob && typeof row.jpegBlob.size === 'number') {
                    total += row.jpegBlob.size;
                }
            }
        }
        return total;
    }

    async function listPendingUploads() {
        const keys = await getAllKeys('pendingUploads');
        const out = [];
        for (const key of keys) {
            const row = await get('pendingUploads', key);
            if (row) out.push({ clientPhotoId: String(key), ...row });
        }
        return out;
    }

    async function putPendingUpload(clientPhotoId, entry) {
        await put('pendingUploads', clientPhotoId, entry);
    }

    async function removePendingUpload(clientPhotoId) {
        await remove('pendingUploads', clientPhotoId);
    }

    async function listPendingNotes() {
        const keys = await getAllKeys('pendingNotes');
        const out = [];
        for (const key of keys) {
            const row = await get('pendingNotes', key);
            if (row) out.push({ clientNoteId: String(key), ...row });
        }
        return out;
    }

    async function putPendingNote(clientNoteId, entry) {
        await put('pendingNotes', clientNoteId, entry);
    }

    async function removePendingNote(clientNoteId) {
        await remove('pendingNotes', clientNoteId);
    }

    async function getSyncMeta(orgId) {
        return (await get('syncMeta', orgKey(orgId))) || {};
    }

    async function patchSyncMeta(orgId, patch) {
        const meta = (await getSyncMeta(orgId)) || {};
        Object.assign(meta, patch);
        await put('syncMeta', orgKey(orgId), meta);
        return meta;
    }

    async function purgeExpiredCaches() {
        const ticketTtl = ticketTtlMs();
        const photoTtl = photoTtlMs();
        const usanTtl = usanDocTtlMs();
        const stores = [
            { name: 'ticketsByOrg', field: 'loadedAt', ttl: ticketTtl },
            { name: 'assignedTicketDetail', field: 'hydratedAt', ttl: ticketTtl },
            { name: 'ticketNotes', field: 'cachedAt', ttl: ticketTtl },
            { name: 'ticketPolygons', field: 'cachedAt', ttl: ticketTtl },
            { name: 'photoMeta', field: 'cachedAt', ttl: photoTtl },
            { name: 'photoBlobs', field: 'cachedAt', ttl: photoTtl },
            { name: 'usanDocs', field: 'cachedAt', ttl: usanTtl },
        ];
        for (const spec of stores) {
            let keys = [];
            try {
                keys = await getAllKeys(spec.name);
            } catch (_e) {
                continue;
            }
            for (const key of keys) {
                try {
                    const row = await get(spec.name, key);
                    if (!row || isRowExpired(row[spec.field], spec.ttl)) {
                        await remove(spec.name, key);
                    }
                } catch (_e) {
                    /* per-key */
                }
            }
        }
    }

    window.offlineStore = {
        openDb,
        get,
        put,
        remove,
        orgKey,
        ticketNotesKey,
        usanDocFullHistoryKey,
        usanDocConfirmationKey,
        putUsanDoc,
        getUsanDoc,
        listUsanDocKeysWithPrefix,
        putTicketsByOrg,
        getTicketsByOrg,
        putTicketPolygon,
        getTicketPolygon,
        putTicketNotes,
        getTicketNotes,
        putAssignedTicketDetail,
        getAssignedTicketDetail,
        putPhotoMeta,
        getPhotoMeta,
        putPhotoBlob,
        getPhotoBlob,
        estimateBlobBytes,
        listPendingUploads,
        putPendingUpload,
        removePendingUpload,
        listPendingNotes,
        putPendingNote,
        removePendingNote,
        getSyncMeta,
        patchSyncMeta,
        purgeExpiredCaches,
    };
})();
