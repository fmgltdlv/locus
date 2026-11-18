/** Shared photo content tag helpers (mirror cloudflare/deploy/src/lib/photoTags.cjs). */

const PHOTO_PRESET_TAGS = Object.freeze(['White Paint', 'Pothole', 'Shallow']);
const PHOTO_TAG_MAX_COUNT = 20;
const PHOTO_TAG_MAX_LEN = 40;
const WHITE_PAINT_CANONICAL = 'White Paint';

function normalizeTagKey(tag) {
    return String(tag || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function compactTagKey(tag) {
    return normalizeTagKey(tag).replace(/\s/g, '');
}

function resolvePresetCanonical(tag) {
    if (tag == null || String(tag).trim() === '') return null;
    const compact = compactTagKey(tag);
    for (let i = 0; i < PHOTO_PRESET_TAGS.length; i++) {
        const preset = PHOTO_PRESET_TAGS[i];
        if (compact === compactTagKey(preset) || normalizeTagKey(tag) === normalizeTagKey(preset)) {
            return preset;
        }
    }
    return null;
}

function normalizePhotoTags(input) {
    let raw = [];
    if (Array.isArray(input)) {
        raw = input;
    } else if (typeof input === 'string') {
        raw = input.split(',');
    } else {
        return [];
    }

    const out = [];
    const seen = new Set();

    for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (item == null) continue;
        let tag = String(item).trim();
        if (!tag) continue;

        const preset = resolvePresetCanonical(tag);
        if (preset) tag = preset;

        if (tag.length > PHOTO_TAG_MAX_LEN) {
            tag = tag.slice(0, PHOTO_TAG_MAX_LEN);
        }
        const key = normalizeTagKey(tag);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
        if (out.length >= PHOTO_TAG_MAX_COUNT) break;
    }

    return out;
}

function photoTagsIncludeWhitePaint(tags) {
    if (!Array.isArray(tags)) return false;
    for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (resolvePresetCanonical(String(t)) === WHITE_PAINT_CANONICAL) return true;
        if (compactTagKey(t) === 'whitepaint') return true;
    }
    return false;
}

function formatPhotoTagsForInput(tags) {
    return normalizePhotoTags(tags).join(', ');
}

function photoHasTag(photo, tagName) {
    if (!photo || tagName == null || String(tagName).trim() === '') return false;
    const want = normalizeTagKey(tagName);
    const tags = getPhotoTags(photo);
    for (let i = 0; i < tags.length; i++) {
        if (normalizeTagKey(tags[i]) === want) return true;
    }
    return false;
}

function getPhotoTagsFromMeta(meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const tags = normalizePhotoTags(m.tags);
    if (m.hasWhitePaintMark === true && !photoTagsIncludeWhitePaint(tags)) {
        return tags.concat([WHITE_PAINT_CANONICAL]);
    }
    return tags;
}

function getPhotoTags(photo) {
    if (!photo) return [];
    let tags = normalizePhotoTags(photo.tags);
    if (photo.hasWhitePaintMark === true && !photoTagsIncludeWhitePaint(tags)) {
        tags = tags.concat([WHITE_PAINT_CANONICAL]);
    } else if (photo.exifData && photo.exifData.hasWhitePaintMark === true && !photoTagsIncludeWhitePaint(tags)) {
        tags = tags.concat([WHITE_PAINT_CANONICAL]);
    }
    return tags;
}

function buildPhotoTagVocabulary(orgTagsFromApi) {
    const presetKeys = new Set(PHOTO_PRESET_TAGS.map(normalizeTagKey));
    const merged = PHOTO_PRESET_TAGS.slice();
    const seen = new Set(presetKeys);
    const extras = [];

    const source = Array.isArray(orgTagsFromApi) ? orgTagsFromApi : [];
    for (let i = 0; i < source.length; i++) {
        const tag = source[i];
        if (tag == null || String(tag).trim() === '') continue;
        const canonical = resolvePresetCanonical(String(tag)) || String(tag).trim();
        const key = normalizeTagKey(canonical);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (presetKeys.has(key)) continue;
        extras.push(canonical);
    }

    extras.sort(function (a, b) {
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    merged.push.apply(merged, extras);
    return merged;
}

function getOrgPhotoTagSuggestions(partial, excludeTags, vocabulary) {
    const exclude = new Set(normalizePhotoTags(excludeTags).map(normalizeTagKey));
    const token = partial != null ? String(partial).trim() : '';
    const vocab = Array.isArray(vocabulary) ? vocabulary : buildPhotoTagVocabulary([]);
    const presetKeySet = new Set(PHOTO_PRESET_TAGS.map(normalizeTagKey));
    const matches = [];

    function eligible(tag) {
        return !exclude.has(normalizeTagKey(tag));
    }

    if (!token) {
        for (let i = 0; i < PHOTO_PRESET_TAGS.length; i++) {
            const preset = PHOTO_PRESET_TAGS[i];
            if (eligible(preset)) matches.push({ tag: preset, preset: true });
        }
        return matches;
    }

    const lower = token.toLowerCase();
    for (let i = 0; i < vocab.length; i++) {
        const tag = vocab[i];
        if (!eligible(tag)) continue;
        if (String(tag).toLowerCase().indexOf(lower) !== 0) continue;
        matches.push({ tag: tag, preset: presetKeySet.has(normalizeTagKey(tag)) });
        if (matches.length >= 12) break;
    }
    return matches;
}

function renderPhotoTagsHtml(tags, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const list = normalizePhotoTags(tags);
    if (!list.length) {
        return options.emptyHtml != null ? options.emptyHtml : '';
    }
    const esc =
        typeof escapeHtmlAttr === 'function'
            ? escapeHtmlAttr
            : function (s) {
                  return String(s)
                      .replace(/&/g, '&amp;')
                      .replace(/</g, '&lt;')
                      .replace(/"/g, '&quot;');
              };
    const presetKeys = new Set(PHOTO_PRESET_TAGS.map(normalizeTagKey));
    return list
        .map(function (tag) {
            const preset = presetKeys.has(normalizeTagKey(tag));
            return (
                '<span class="photo-tag-chip' +
                (preset ? ' photo-tag-chip--preset' : '') +
                '">' +
                esc(tag) +
                '</span>'
            );
        })
        .join('');
}

const orgPhotoTagVocabularyCache = Object.create(null);

function invalidateOrgPhotoTagVocabulary(orgId) {
    if (orgId == null) {
        Object.keys(orgPhotoTagVocabularyCache).forEach(function (k) {
            delete orgPhotoTagVocabularyCache[k];
        });
        return;
    }
    delete orgPhotoTagVocabularyCache[String(orgId)];
}

async function fetchOrgPhotoTagVocabulary(orgId) {
    const key = orgId != null ? String(orgId) : '';
    if (key && orgPhotoTagVocabularyCache[key]) {
        return orgPhotoTagVocabularyCache[key];
    }
    if (!window.authModule || !window.authModule.isAuthenticated || !window.authModule.isAuthenticated()) {
        return buildPhotoTagVocabulary(collectOrgPhotoTagsFromLocalPhotos());
    }
    const qs = orgId != null ? `?organizationId=${encodeURIComponent(String(orgId))}` : '';
    try {
        const data = await window.authModule.apiRequest(
            `${window.authModule.API_BASE}/data/media/photo-tags${qs}`
        );
        const orgTags = data && Array.isArray(data.tags) ? data.tags : [];
        const vocabulary = buildPhotoTagVocabulary(orgTags);
        if (key) orgPhotoTagVocabularyCache[key] = vocabulary;
        return vocabulary;
    } catch (err) {
        console.warn('fetchOrgPhotoTagVocabulary:', err);
        return buildPhotoTagVocabulary(collectOrgPhotoTagsFromLocalPhotos());
    }
}

function collectOrgPhotoTagsFromLocalPhotos() {
    const photos = (window.photosModule && window.photosModule.savedPhotos) || [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < photos.length; i++) {
        const tags = getPhotoTags(photos[i]);
        for (let j = 0; j < tags.length; j++) {
            const tag = tags[j];
            const k = normalizeTagKey(tag);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push(tag);
        }
    }
    return out;
}

function collectDistinctTagsFromPhotos(photos) {
    const out = [];
    const seen = new Set();
    const list = Array.isArray(photos) ? photos : [];
    for (let i = 0; i < list.length; i++) {
        const tags = getPhotoTags(list[i]);
        for (let j = 0; j < tags.length; j++) {
            const tag = tags[j];
            const k = normalizeTagKey(tag);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push(tag);
        }
    }
    out.sort(function (a, b) {
        const aPreset = PHOTO_PRESET_TAGS.indexOf(a);
        const bPreset = PHOTO_PRESET_TAGS.indexOf(b);
        if (aPreset !== -1 && bPreset !== -1) return aPreset - bPreset;
        if (aPreset !== -1) return -1;
        if (bPreset !== -1) return 1;
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    return out;
}

function photoMatchesTagFilter(photo, tagName) {
    if (!tagName || String(tagName).trim() === '') return true;
    if (normalizeTagKey(tagName) === normalizeTagKey(WHITE_PAINT_CANONICAL)) {
        const mod = window.photoTicketAssociationModule;
        if (mod && typeof mod.photoHasWhitePaintMark === 'function') {
            return mod.photoHasWhitePaintMark(photo);
        }
    }
    return photoHasTag(photo, tagName);
}

window.photoTagsModule = {
    PHOTO_PRESET_TAGS,
    PHOTO_TAG_MAX_COUNT,
    PHOTO_TAG_MAX_LEN,
    WHITE_PAINT_CANONICAL,
    normalizePhotoTags,
    resolvePresetCanonical,
    photoTagsIncludeWhitePaint,
    formatPhotoTagsForInput,
    photoHasTag,
    getPhotoTags,
    getPhotoTagsFromMeta,
    buildPhotoTagVocabulary,
    getOrgPhotoTagSuggestions,
    renderPhotoTagsHtml,
    fetchOrgPhotoTagVocabulary,
    collectOrgPhotoTagsFromLocalPhotos,
    collectDistinctTagsFromPhotos,
    invalidateOrgPhotoTagVocabulary,
    photoMatchesTagFilter,
};
