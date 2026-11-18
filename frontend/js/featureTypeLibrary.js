// Org-scoped annotation feature type library (settings.annotationFeatureTypeLibrary)

const ANNOTATION_FEATURE_TYPE_LIBRARY_KEY = 'annotationFeatureTypeLibrary';
const ORG_TYPE_PREFIX = 'orgType:';

/** UI + persistence values for line/polygon stroke */
const LINE_PATTERN_OPTIONS = [
    { value: 'solid', label: 'Solid' },
    { value: 'dashed', label: 'Dashed' },
    { value: 'dotted', label: 'Dotted' },
    { value: 'longDash', label: 'Long dash' },
    { value: 'dashDot', label: 'Dash dot' },
    { value: 'squiggly', label: 'Squiggly (approx.)' }
];

const DEFAULT_LINE_PATTERN = 'solid';

function normalizeLibraryEntries(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(e => e && e.id && typeof e.id === 'string');
}

function getAnnotationFeatureTypeLibraryFromOrg(org) {
    if (!org || !org.settings) return [];
    return normalizeLibraryEntries(org.settings[ANNOTATION_FEATURE_TYPE_LIBRARY_KEY]);
}

function getAnnotationFeatureTypeLibraryForOrgId(orgId) {
    const id = orgId != null ? Number(orgId) : null;
    if (!id || isNaN(id)) return [];
    const getOrgs = window.orgSelectorModule && window.orgSelectorModule.getOrganizations;
    const orgs = typeof getOrgs === 'function' ? getOrgs() : [];
    const org = orgs.find(o => o.id === id);
    return getAnnotationFeatureTypeLibraryFromOrg(org);
}

function parseOrgTypeKey(utilityType) {
    if (!utilityType || typeof utilityType !== 'string') return null;
    if (!utilityType.startsWith(ORG_TYPE_PREFIX)) return null;
    const id = utilityType.slice(ORG_TYPE_PREFIX.length).trim();
    return id || null;
}

function findLibraryEntry(library, id) {
    if (!library || !id) return null;
    return library.find(e => e.id === id) || null;
}

/**
 * Resolve color and linePattern from built-in utility type key or orgType:<uuid>.
 * @param {string} utilityTypeKey - built-in name or orgType:uuid
 * @param {Array} [library] - optional; loaded if omitted via current org
 */
function resolveFeatureTypeStyle(utilityTypeKey, library) {
    const ut = utilityTypeKey != null ? String(utilityTypeKey) : '';
    const lib = library != null ? library : getAnnotationFeatureTypeLibraryForOrgId(window.getCurrentOrgId && window.getCurrentOrgId());

    const customTypeId = parseOrgTypeKey(ut);
    if (customTypeId) {
        const entry = findLibraryEntry(lib, customTypeId);
        if (entry) {
            const color = entry.color && String(entry.color).trim() ? String(entry.color).trim() : 'var(--app-accent)';
            const linePattern = entry.linePattern && String(entry.linePattern).trim()
                ? String(entry.linePattern).trim()
                : DEFAULT_LINE_PATTERN;
            return { color, linePattern: linePattern };
        }
        return { color: 'var(--app-accent)', linePattern: DEFAULT_LINE_PATTERN };
    }

    const utilityTypesModule = window.utilityTypesModule;
    const color = utilityTypesModule && typeof utilityTypesModule.getColorFromUtilityType === 'function'
        ? utilityTypesModule.getColorFromUtilityType(ut)
        : 'var(--app-accent)';
    return { color, linePattern: DEFAULT_LINE_PATTERN };
}

/** Leaflet path options: omit dashArray when solid */
function linePatternToPathOptions(linePattern) {
    const p = linePattern && String(linePattern).trim() ? String(linePattern).trim() : DEFAULT_LINE_PATTERN;
    const dashMap = {
        solid: null,
        dashed: '10, 10',
        dotted: '2, 8',
        longDash: '20, 10',
        dashDot: '12, 8, 2, 8',
        squiggly: '4, 6, 2, 6'
    };
    const dashArray = dashMap[p] != null ? dashMap[p] : null;
    const opts = {};
    if (dashArray) opts.dashArray = dashArray;
    return opts;
}

function mergePolylineStyle(base, annotation) {
    const pattern = annotation && annotation.linePattern
        ? String(annotation.linePattern).trim()
        : DEFAULT_LINE_PATTERN;
    return Object.assign({}, base, linePatternToPathOptions(pattern));
}

function mergePolygonStyle(base, annotation) {
    return mergePolylineStyle(base, annotation);
}

function escapeOptionAttr(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Inner HTML for Utility Type &lt;select&gt; (optgroups Standard + Organization).
 * @param {string} selectedValue - built-in name or orgType:uuid
 * @param {boolean} [includePlaceholder=false] - leading "Select utility type..." option
 */
function buildUtilityTypeSelectOptionsHtml(selectedValue, includePlaceholder) {
    const utilityTypesModule = window.utilityTypesModule;
    const options = utilityTypesModule?.UTILITY_TYPE_OPTIONS || [
        'Gas', 'Power', 'Comm', 'Sewer', 'Water', 'Survey', 'Other'
    ];
    const orgId = typeof window.getCurrentOrgId === 'function' ? window.getCurrentOrgId() : null;
    const library = getAnnotationFeatureTypeLibraryForOrgId(orgId);

    let html = '';
    if (includePlaceholder) {
        html += '<option value="">Select utility type...</option>';
    }
    html += '<optgroup label="Standard (APWA)">';
    html += options.map(type => {
        const sel = type === selectedValue ? ' selected' : '';
        return `<option value="${escapeOptionAttr(type)}"${sel}>${escapeOptionAttr(type)}</option>`;
    }).join('');
    html += '</optgroup>';
    if (library.length > 0) {
        html += '<optgroup label="Organization">';
        library.forEach(entry => {
            const val = ORG_TYPE_PREFIX + entry.id;
            const sel = val === selectedValue ? ' selected' : '';
            const lab = entry.label || entry.id;
            html += `<option value="${escapeOptionAttr(val)}"${sel}>${escapeOptionAttr(lab)}</option>`;
        });
        html += '</optgroup>';
    }
    return html;
}

window.featureTypeLibraryModule = {
    ANNOTATION_FEATURE_TYPE_LIBRARY_KEY,
    ORG_TYPE_PREFIX,
    LINE_PATTERN_OPTIONS,
    DEFAULT_LINE_PATTERN,
    normalizeLibraryEntries,
    getAnnotationFeatureTypeLibraryFromOrg,
    getAnnotationFeatureTypeLibraryForOrgId,
    parseOrgTypeKey,
    findLibraryEntry,
    resolveFeatureTypeStyle,
    linePatternToPathOptions,
    mergePolylineStyle,
    mergePolygonStyle,
    escapeOptionAttr,
    buildUtilityTypeSelectOptionsHtml
};
