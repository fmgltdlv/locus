// Manage Data — mobile "Info" sheet for row fields hidden on small screens

function openManageDataRowInfo(title, fields) {
    const overlay = document.getElementById('manageDataRowInfoOverlay');
    if (!overlay) return;
    // Track which photo (if any) this sheet shows so it can be refreshed after note/tag edits
    const photoField = (fields || []).find((f) => f && f.editPhotoNoteId);
    overlay.dataset.photoId = photoField ? String(photoField.editPhotoNoteId) : '';
    const titleEl = document.getElementById('manageDataRowInfoTitle');
    const bodyEl = document.getElementById('manageDataRowInfoBody');
    if (titleEl) titleEl.textContent = title || 'Details';
    if (bodyEl) {
        bodyEl.innerHTML = '';
        (fields || []).forEach((field) => {
            const { label, value, editPhotoNoteId, editPhotoGpsId, publicToggleLayerId, publicTogglePhotoId, publicTogglePhotoFileId, publicChecked, multiline } = field || {};
            const dt = document.createElement('dt');
            dt.className = 'manage-data-row-info-dt';
            dt.textContent = label || '';
            const dd = document.createElement('dd');
            dd.className = 'manage-data-row-info-dd';
            if (editPhotoNoteId && window.photosModule && (window.photosModule.promptEditPhotoDetails || window.photosModule.promptEditPhotoNote)) {
                const valueText = document.createElement('span');
                valueText.textContent = value == null || value === '' ? '—' : String(value);
                if (multiline) valueText.style.whiteSpace = 'pre-line';

                const editButton = document.createElement('button');
                editButton.type = 'button';
                editButton.className = 'data-action-button';
                editButton.textContent = 'Edit note & tags';
                editButton.style.marginLeft = '0.5rem';
                editButton.addEventListener('click', function () {
                    closeManageDataRowInfo();
                    if (window.photosModule.promptEditPhotoDetails) {
                        window.photosModule.promptEditPhotoDetails(String(editPhotoNoteId));
                    } else {
                        window.photosModule.promptEditPhotoNote(String(editPhotoNoteId));
                    }
                });

                dd.appendChild(valueText);
                dd.appendChild(editButton);
            } else if (editPhotoGpsId && typeof window.editPhotoManualLocation === 'function') {
                const valueText = document.createElement('span');
                valueText.textContent = value == null || value === '' ? '—' : String(value);

                const editButton = document.createElement('button');
                editButton.type = 'button';
                editButton.className = 'data-action-button';
                editButton.textContent = 'Edit GPS';
                editButton.style.marginLeft = '0.5rem';
                editButton.addEventListener('click', function () {
                    closeManageDataRowInfo();
                    window.editPhotoManualLocation(String(editPhotoGpsId));
                });

                dd.appendChild(valueText);
                dd.appendChild(editButton);
            } else if (publicToggleLayerId || publicTogglePhotoId) {
                const toggleLabel = document.createElement('label');
                toggleLabel.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = !!publicChecked;
                checkbox.addEventListener('change', function () {
                    if (publicToggleLayerId && typeof window.toggleLayerPublic === 'function') {
                        window.toggleLayerPublic(String(publicToggleLayerId), checkbox.checked, checkbox);
                    } else if (publicTogglePhotoId && typeof window.togglePhotoPublic === 'function') {
                        window.togglePhotoPublic(String(publicTogglePhotoId), publicTogglePhotoFileId, checkbox.checked, checkbox);
                    }
                });

                const labelText = document.createElement('span');
                labelText.textContent = 'Make public';

                toggleLabel.appendChild(checkbox);
                toggleLabel.appendChild(labelText);
                dd.appendChild(toggleLabel);
            } else {
                dd.textContent = value == null || value === '' ? '—' : String(value);
            }
            bodyEl.appendChild(dt);
            bodyEl.appendChild(dd);
        });
    }
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
}

function closeManageDataRowInfo() {
    const overlay = document.getElementById('manageDataRowInfoOverlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
}

/** Rebuild the info sheet in place when it is open for this photo (after note/tag edits). */
function refreshManageDataRowInfoForPhoto(photo) {
    const overlay = document.getElementById('manageDataRowInfoOverlay');
    if (!overlay || !overlay.classList.contains('is-open')) return;
    if (!photo || overlay.dataset.photoId !== String(photo.id)) return;
    const renderer = window.photosTableRenderer;
    if (!renderer || typeof renderer.buildPhotoInfoFields !== 'function') return;
    const utils = window.tableUtilsModule || {};
    const createdDate = utils.formatDataTableDateCell
        ? utils.formatDataTableDateCell(photo.createdAt)
        : window.formatRecordedDateTime(photo.createdAt);
    openManageDataRowInfo('Photo', renderer.buildPhotoInfoFields(photo, createdDate));
}

function openManageDataRowInfoFromDataset(btn) {
    if (!btn || !btn.dataset.manageInfo) return;
    try {
        const parsed = JSON.parse(decodeURIComponent(btn.dataset.manageInfo));
        openManageDataRowInfo(parsed.title, parsed.fields);
    } catch (e) {
        console.error('manageDataRowInfo:', e);
    }
}

/**
 * @param {string} title
 * @param {{ label: string, value?: string, editPhotoNoteId?: string, multiline?: boolean }[]} fields
 * @param {{ alwaysVisible?: boolean, labelHtml?: string, className?: string, ariaLabel?: string }} [options]
 *   - `alwaysVisible`: show on desktop too (default: mobile-only via CSS)
 *   - `labelHtml`: custom button contents (e.g. icon); default "Info"
 */
function manageDataRowInfoButton(title, fields, options) {
    const enc = encodeURIComponent(JSON.stringify({ title, fields: fields || [] }));
    const alwaysClass = options && options.alwaysVisible ? ' manage-data-row-info-btn-always' : '';
    const extraClass = options && options.className ? ` ${options.className}` : '';
    const label = options && options.labelHtml != null ? options.labelHtml : 'Info';
    const aria =
        options && options.ariaLabel
            ? ` aria-label="${typeof escapeHtmlAttr === 'function' ? escapeHtmlAttr(options.ariaLabel) : options.ariaLabel}"`
            : '';
    return `<button type="button" class="data-action-button manage-data-row-info-btn${alwaysClass}${extraClass}" data-action="manage-info" data-manage-info="${enc}" title="More details"${aria}>${label}</button>`;
}

window.openManageDataRowInfo = openManageDataRowInfo;
window.refreshManageDataRowInfoForPhoto = refreshManageDataRowInfoForPhoto;
window.closeManageDataRowInfo = closeManageDataRowInfo;
window.openManageDataRowInfoFromDataset = openManageDataRowInfoFromDataset;
window.manageDataRowInfoButton = manageDataRowInfoButton;
