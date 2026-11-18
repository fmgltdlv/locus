// Table utility functions

// Format file size helper
function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Calculate approximate file size from base64 data URL
function calculateDataUrlSize(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return 0;
    
    // Remove data URL prefix (e.g., "data:image/jpeg;base64,")
    const base64Data = dataUrl.split(',')[1];
    if (!base64Data) return 0;
    
    // Base64 encoding increases size by ~33%, so we divide by 1.33
    // Also account for padding
    const padding = (base64Data.match(/=/g) || []).length;
    const size = (base64Data.length * 3) / 4 - padding;
    
    return Math.round(size);
}

// Get utility type display (handles both color and utilityType) - returns HTML
function getUtilityTypeDisplay(color, utilityType) {
    const utilityTypesModule = window.utilityTypesModule;
    if (!utilityTypesModule) {
        const safeColor =
            typeof escapeHtmlAttr === 'function'
                ? escapeHtmlAttr(color || 'var(--app-accent)')
                : String(color || 'var(--app-accent)').replace(/"/g, '');
        return `<span class="data-color-indicator" style="background-color: ${safeColor};"></span>`;
    }
    
    // If utilityType is set, use it; otherwise try to infer from color
    let displayType = utilityType;
    if (!displayType && color) {
        displayType = utilityTypesModule.getUtilityTypeFromColor(color);
    }
    
    if (displayType && displayType !== 'Other') {
        const utilityColor = utilityTypesModule.getColorFromUtilityType(displayType);
        const safeColor =
            typeof escapeHtmlAttr === 'function'
                ? escapeHtmlAttr(utilityColor || color || 'var(--app-accent)')
                : String(utilityColor || color || 'var(--app-accent)').replace(/"/g, '');
        const safeLabel =
            typeof escapeHtmlText === 'function' ? escapeHtmlText(displayType) : String(displayType);
        return `
            <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span class="data-color-indicator" style="background-color: ${safeColor};"></span>
                <span style="color: var(--app-text-primary); font-size: 0.875rem;">${safeLabel}</span>
            </div>
        `;
    }

    const safeColor =
        typeof escapeHtmlAttr === 'function'
            ? escapeHtmlAttr(color || 'var(--app-accent)')
            : String(color || 'var(--app-accent)').replace(/"/g, '');
    return `<span class="data-color-indicator" style="background-color: ${safeColor};"></span>`;
}

// Get GPS source display - returns HTML
function getGpsSourceDisplay(gpsSource) {
    if (!gpsSource || gpsSource === 'None') {
        return '<span style="color: var(--app-danger);">None</span>';
    } else if (gpsSource === 'EXIF') {
        return '<span style="color: var(--app-success);">EXIF</span>';
    } else if (gpsSource === 'Manual') {
        return '<span style="color: var(--app-accent);">Manual</span>';
    }
    return gpsSource;
}

// Get utility type options for select dropdown (APWA + org feature library)
function getUtilityTypeOptions(selectedType) {
    const ft = window.featureTypeLibraryModule;
    if (ft && typeof ft.buildUtilityTypeSelectOptionsHtml === 'function') {
        return ft.buildUtilityTypeSelectOptionsHtml(selectedType, false);
    }
    const utilityTypesModule = window.utilityTypesModule;
    const options = utilityTypesModule?.UTILITY_TYPE_OPTIONS || ['Gas', 'Power', 'Comm', 'Sewer', 'Water', 'Survey', 'Other'];
    return options.map(type =>
        `<option value="${type}" ${type === selectedType ? 'selected' : ''}>${type}</option>`
    ).join('');
}

/** Escaped date/time for data table cells. */
function formatDataTableDateCell(value) {
    const formatted = window.formatRecordedDateTime ? window.formatRecordedDateTime(value) : '';
    const text = formatted || '—';
    return typeof escapeHtmlText === 'function' ? escapeHtmlText(text) : text;
}

/** Escaped short date for incident-style columns. */
function formatDataTableShortDateCell(value) {
    if (!value) return '—';
    const formatted =
        typeof window.formatRecordedDate === 'function' ? window.formatRecordedDate(value, '') : '';
    const text = formatted || '—';
    return typeof escapeHtmlText === 'function' ? escapeHtmlText(text) : text;
}

function toValidDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Local YYYY-MM-DD key used to group Data Hub rows by calendar day. */
function getDataTableLocalDayKey(value) {
    const date = toValidDate(value);
    if (!date) return 'unknown';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getDateOnlyTime(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Human-friendly label for Data Hub day section headers. */
function formatDataTableDayLabel(dayKey) {
    if (!dayKey || dayKey === 'unknown') return 'No date';
    const parts = String(dayKey).split('-').map((part) => parseInt(part, 10));
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 'No date';
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    const today = new Date();
    const diffDays = Math.round((getDateOnlyTime(today) - getDateOnlyTime(date)) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}

/** Preserve input item order while splitting rows into local-day buckets. */
function groupDataTableItemsByDay(items, getDateValue) {
    const buckets = [];
    const byKey = new Map();
    (items || []).forEach((item) => {
        const key = getDataTableLocalDayKey(getDateValue ? getDateValue(item) : item?.createdAt);
        let bucket = byKey.get(key);
        if (!bucket) {
            bucket = {
                key,
                label: formatDataTableDayLabel(key),
                items: [],
            };
            byKey.set(key, bucket);
            buckets.push(bucket);
        }
        bucket.items.push(item);
    });
    return buckets;
}

/** Reorder day buckets when sorting by created date (newest/oldest first). */
function sortDayBucketsByDate(buckets, direction) {
    const list = [...(buckets || [])];
    const desc = direction === 'desc';
    list.sort((a, b) => {
        const ak = a.key === 'unknown' ? '' : a.key || '';
        const bk = b.key === 'unknown' ? '' : b.key || '';
        if (!ak && !bk) return 0;
        if (!ak) return 1;
        if (!bk) return -1;
        if (ak < bk) return desc ? 1 : -1;
        if (ak > bk) return desc ? -1 : 1;
        return 0;
    });
    return list;
}

function renderDataTableDateSectionRow(label, count, itemLabel) {
    const safeLabel = typeof escapeHtmlText === 'function' ? escapeHtmlText(label || 'No date') : String(label || 'No date');
    const safeItemLabel = typeof escapeHtmlText === 'function' ? escapeHtmlText(itemLabel || 'item') : String(itemLabel || 'item');
    const suffix = count === 1 ? safeItemLabel : `${safeItemLabel}s`;
    return `
        <tr class="data-date-section-row photo-batch-header">
            <td class="data-date-section-cell" colspan="6">
                <span class="data-date-section-title">${safeLabel}</span>
                <span class="data-date-section-count">(${count} ${suffix})</span>
            </td>
        </tr>
    `;
}

/** Update empty-state message without destroying inner markup. */
function setDataTableEmptyMessage(emptyState, message) {
    if (!emptyState) return;
    const p = emptyState.querySelector('p');
    if (p) {
        p.textContent = message;
    } else {
        emptyState.textContent = message;
    }
}

// Export module
window.tableUtilsModule = {
    formatFileSize,
    calculateDataUrlSize,
    getUtilityTypeDisplay,
    getGpsSourceDisplay,
    getUtilityTypeOptions,
    formatDataTableDateCell,
    formatDataTableShortDateCell,
    getDataTableLocalDayKey,
    formatDataTableDayLabel,
    groupDataTableItemsByDay,
    sortDayBucketsByDate,
    renderDataTableDateSectionRow,
    setDataTableEmptyMessage,
};

