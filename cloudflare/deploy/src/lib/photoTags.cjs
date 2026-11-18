/** @typedef {string[]} PhotoTagList */

const PHOTO_PRESET_TAGS = Object.freeze(["White Paint", "Pothole", "Shallow"]);
const PHOTO_TAG_MAX_COUNT = 20;
const PHOTO_TAG_MAX_LEN = 40;

function normalizeTagKey(tag) {
  return String(tag || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function compactTagKey(tag) {
  return normalizeTagKey(tag).replace(/\s/g, "");
}

/**
 * Map user input to a canonical preset string, or null if not a preset alias.
 * @param {string} tag
 * @returns {string|null}
 */
function resolvePresetCanonical(tag) {
  if (tag == null || String(tag).trim() === "") return null;
  const compact = compactTagKey(tag);
  for (const preset of PHOTO_PRESET_TAGS) {
    if (compact === compactTagKey(preset) || normalizeTagKey(tag) === normalizeTagKey(preset)) {
      return preset;
    }
  }
  return null;
}

/**
 * @param {unknown} input
 * @returns {PhotoTagList}
 */
function normalizePhotoTags(input) {
  let raw = [];
  if (Array.isArray(input)) {
    raw = input;
  } else if (typeof input === "string") {
    raw = input.split(",");
  } else {
    return [];
  }

  const out = [];
  const seen = new Set();

  for (const item of raw) {
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

/**
 * @param {PhotoTagList|unknown} tags
 * @returns {boolean}
 */
function photoTagsIncludeWhitePaint(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => resolvePresetCanonical(String(t)) === "White Paint" || compactTagKey(t) === "whitepaint");
}

/**
 * @param {string[]} orgTags
 * @returns {{ tags: string[], presets: string[] }}
 */
function mergePhotoTagVocabulary(orgTags) {
  const presetKeys = new Set(PHOTO_PRESET_TAGS.map(normalizeTagKey));
  const merged = [...PHOTO_PRESET_TAGS];
  const seen = new Set(presetKeys);

  const extras = [];
  for (const tag of orgTags || []) {
    if (tag == null || String(tag).trim() === "") continue;
    const canonical = resolvePresetCanonical(String(tag)) || String(tag).trim();
    const key = normalizeTagKey(canonical);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (presetKeys.has(key)) continue;
    extras.push(canonical);
  }

  extras.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  merged.push(...extras);
  return { tags: merged, presets: [...PHOTO_PRESET_TAGS] };
}

/**
 * Collect distinct tags from parsed metadata objects.
 * @param {Record<string, unknown>[]} metas
 * @returns {string[]}
 */
function collectTagsFromMediaMetas(metas) {
  const orgTags = [];
  const seen = new Set();
  for (const meta of metas || []) {
    const tags = meta && Array.isArray(meta.tags) ? meta.tags : [];
    for (const t of tags) {
      if (t == null || String(t).trim() === "") continue;
      const canonical = resolvePresetCanonical(String(t)) || String(t).trim();
      const key = normalizeTagKey(canonical);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      orgTags.push(canonical);
    }
  }
  return orgTags;
}

module.exports = {
  PHOTO_PRESET_TAGS,
  PHOTO_TAG_MAX_COUNT,
  PHOTO_TAG_MAX_LEN,
  normalizePhotoTags,
  resolvePresetCanonical,
  photoTagsIncludeWhitePaint,
  mergePhotoTagVocabulary,
  collectTagsFromMediaMetas,
};
