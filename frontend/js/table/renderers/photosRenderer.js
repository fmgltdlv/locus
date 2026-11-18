// Photos gallery renderer (date headers + thumbnail cards; no inline groups/batches)

function dataTableLocationIconHtml(size) {
    const icons = window.mapIcons;
    const s = size || 16;
    if (icons && typeof icons.location === 'function') {
        return `<span class="photos-gallery-card__icon" aria-hidden="true">${icons.location(s)}</span>`;
    }
    return '📍';
}

function dataTableInfoIconHtml(size) {
    const icons = window.mapIcons;
    const s = size || 16;
    if (icons && typeof icons.about === 'function') {
        return `<span class="photos-gallery-card__icon" aria-hidden="true">${icons.about(s)}</span>`;
    }
    return 'ℹ';
}

function dataTableTrashIconHtml(size) {
    const icons = window.mapIcons;
    const s = size || 16;
    if (icons && typeof icons.trash === 'function') {
        return `<span class="photos-gallery-card__icon" aria-hidden="true">${icons.trash(s)}</span>`;
    }
    return '🗑';
}

function photoTableImgAttrs(photo) {
    const thumbUrl =
        window.photosModule && typeof window.photosModule.getPhotoThumbnailDisplayUrl === 'function'
            ? window.photosModule.getPhotoThumbnailDisplayUrl(photo)
            : photo.thumbnailUrl;
    const imgSrc = photo.fileId
        ? ''
        : thumbUrl ||
          (window.photosModule?.getPhotoImageUrl ? window.photosModule.getPhotoImageUrl(photo) : photo.imageUrl);
    if (photo.fileId && photo.thumbnailUrl) {
        return `data-file-id="${photo.fileId}" data-use-thumbnail="1"`;
    }
    if (photo.fileId) {
        return `data-file-id="${photo.fileId}"`;
    }
    return imgSrc ? `src="${imgSrc}"` : '';
}

function formatPhotoCoordinates(photo) {
    const lat = Number(photo.latlng?.lat);
    const lng = Number(photo.latlng?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function formatExifValue(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch (_) {
            return String(value);
        }
    }
    return String(value);
}

function formatExifLabel(key) {
    const knownLabels = {
        dateTime: 'Date / Time',
        gpsLat: 'GPS Latitude',
        gpsLng: 'GPS Longitude',
        gpsSource: 'GPS Source',
        hasGPS: 'Has GPS',
    };
    if (knownLabels[key]) return knownLabels[key];
    return String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPhotoGpsExifDetails(photo) {
    const rows = [];
    const add = (label, value) => {
        const formatted = formatExifValue(value);
        if (formatted) rows.push(`${label}: ${formatted}`);
    };
    const coordinates = formatPhotoCoordinates(photo);
    add('Coordinates', coordinates);

    const exif = photo.exifData || {};
    const orderedKeys = ['dateTime', 'make', 'model', 'orientation', 'gpsSource', 'hasGPS', 'gpsLat', 'gpsLng'];
    const seen = new Set();
    orderedKeys.forEach((key) => {
        seen.add(key);
        add(formatExifLabel(key), exif[key]);
    });
    Object.keys(exif)
        .sort()
        .forEach((key) => {
            if (seen.has(key)) return;
            add(formatExifLabel(key), exif[key]);
        });
    return rows.join('\n');
}

function buildPhotoInfoFields(photo, createdDate) {
    const fields = [
        { label: 'Type', value: 'Photo' },
        { label: 'File name', value: photo.fileName || '—' },
        { label: 'GPS / EXIF', value: formatPhotoGpsExifDetails(photo) },
        { label: 'Added', value: createdDate },
    ];
    const noteText = photo.note && String(photo.note).trim() ? String(photo.note).trim() : '';
    const tagMod = window.photoTagsModule;
    const photoTags = tagMod && typeof tagMod.getPhotoTags === 'function' ? tagMod.getPhotoTags(photo) : [];
    const tagsText = photoTags.length ? photoTags.join(', ') : '';
    const notesTagsLines = [];
    if (noteText) notesTagsLines.push(`Note: ${noteText}`);
    if (tagsText) notesTagsLines.push(`Tags: ${tagsText}`);
    fields.push({
        label: 'Notes & tags',
        value: notesTagsLines.join('\n'),
        editPhotoNoteId: String(photo.id),
        multiline: true,
    });
    if (photo.uploadedBy) fields.push({ label: 'Uploaded by', value: String(photo.uploadedBy) });
    if (photo.noteLastEditedBy && photo.note && String(photo.note).trim()) {
        let line = String(photo.noteLastEditedBy);
        if (photo.noteLastEditedAt) {
            const when = window.formatRecordedDateTime(photo.noteLastEditedAt, '', '');
            if (when) line += ' · ' + when;
        }
        fields.push({ label: 'Last note by', value: line });
    }
    if (photo.gpsLastEditedBy) {
        let line = String(photo.gpsLastEditedBy);
        if (photo.gpsLastEditedAt) {
            const when = window.formatRecordedDateTime(photo.gpsLastEditedAt, '', '');
            if (when) line += ' · ' + when;
        }
        fields.push({ label: 'Last GPS by', value: line });
    }
    const manualGps =
        window.photosModule && window.photosModule.isPhotoManualGps
            ? window.photosModule.isPhotoManualGps(photo)
            : !!(photo.latlng && photo.exifData && photo.exifData.gpsSource === 'Manual');
    if (manualGps) {
        fields.push({
            label: 'GPS location',
            value: 'Manual — use Edit GPS',
            editPhotoGpsId: String(photo.id),
        });
    }
    const mod = window.photoTicketAssociationModule;
    const assocId =
        mod && typeof mod.getPhotoAssociatedTicketId === 'function' ? mod.getPhotoAssociatedTicketId(photo) : null;
    if (assocId != null) {
        const tickets = window.ORG_TICKETS || [];
        const linked = tickets.find((t) => {
            if (typeof window.ticketIdEquals === 'function') return window.ticketIdEquals(t.id, assocId);
            return String(t.id) === String(assocId);
        });
        const label = linked && linked.ticketNumber != null ? String(linked.ticketNumber) : String(assocId);
        fields.push({ label: 'Ticket association', value: `#${label} (no GPS)` });
    }
    if (canShowPhotoPublicToggle(photo)) {
        fields.push({
            label: 'Public sharing',
            publicTogglePhotoId: String(photo.id),
            publicTogglePhotoFileId: photo.fileId,
            publicChecked: !!photo.isPublic,
        });
    }
    return fields;
}

function canShowPhotoPublicToggle(photo) {
    if (!window.photosModule?.canAdminPhotoPublicFlag?.()) return false;
    if (photo.shared || photo.fileId == null) return false;
    if (typeof window.isCurrentOrgPublicCatalogViewer === 'function' && window.isCurrentOrgPublicCatalogViewer()) {
        return false;
    }
    return true;
}

function isManualGpsPhoto(photo) {
    return window.photosModule && window.photosModule.isPhotoManualGps
        ? window.photosModule.isPhotoManualGps(photo)
        : !!(photo.latlng && photo.exifData && photo.exifData.gpsSource === 'Manual');
}

function locationActionButtonHtml(photo) {
    const T = window.tableActionHtml;
    const icon = dataTableLocationIconHtml(16);
    if (isManualGpsPhoto(photo) || photo.latlng) {
        return T.btn('zoom-to-photo', { id: photo.id }, icon, {
            className: 'photos-gallery-card__action zoom-pin-button',
            title: 'Zoom to Location',
            ariaLabel: 'Zoom to Location',
        });
    }
    // No GPS: open a small menu (Tag GPS / Associate to ticket)
    return T.btn('photo-location-menu', { id: photo.id }, icon, {
        className: 'photos-gallery-card__action',
        title: 'Location options',
        ariaLabel: 'Location options',
    });
}

function photoGalleryCard(photo, selectedDataIds) {
    const T = window.tableActionHtml;
    const pidAttr = escapeHtmlAttr(photo.id);
    const isSelected = selectedDataIds.has(photo.id) || selectedDataIds.has(String(photo.id));
    const createdDateFull = window.formatRecordedDateTime
        ? window.formatRecordedDateTime(photo.createdAt)
        : '';
    const dateOnly = window.formatRecordedDate
        ? escapeHtmlText(window.formatRecordedDate(photo.createdAt, '', ''))
        : escapeHtmlText(createdDateFull);
    const imgAttrs = photoTableImgAttrs(photo);
    const nameAlt = escapeHtmlAttr(
        window.truncateImageNameForDisplay
            ? window.truncateImageNameForDisplay(String(photo.fileName || 'Photo'))
            : String(photo.fileName || 'Photo')
    );
    const infoBtn = window.manageDataRowInfoButton
        ? window.manageDataRowInfoButton('Photo', buildPhotoInfoFields(photo, createdDateFull), {
              alwaysVisible: true,
              labelHtml: dataTableInfoIconHtml(16),
              className: 'photos-gallery-card__action',
              ariaLabel: 'Photo details',
          })
        : '';
    const publicBadge = T.publicIndicator ? T.publicIndicator(photo.isPublic) : '';
    const deleteHtml =
        window.orgDataPermissionsModule && !window.orgDataPermissionsModule.canDeleteOrgData()
            ? ''
            : T.btn('delete-photo', { id: photo.id }, dataTableTrashIconHtml(16), {
                  delete: true,
                  className: 'photos-gallery-card__action photos-gallery-card__action--delete',
                  title: 'Delete',
                  ariaLabel: 'Delete',
              });

    return `
        <div class="photos-gallery-card${isSelected ? ' is-selected' : ''}" data-id="${pidAttr}" data-type="photo">
            <div class="photos-gallery-card__select">
                ${T.checkbox('toggle-selection', { id: photo.id }, isSelected)}
            </div>
            <div class="photos-gallery-card__thumb-wrap">
                ${T.viewPhotoTrigger(photo.id, imgAttrs, nameAlt, {
                    className: 'photos-gallery-card__img data-table-photo-select-thumb',
                    ariaLabel: 'View photo. Press and hold to select.',
                })}
                ${publicBadge ? `<span class="photos-gallery-card__public">${publicBadge}</span>` : ''}
            </div>
            <div class="photos-gallery-card__footer">
                <div class="photos-gallery-card__actions">
                    ${infoBtn}
                    ${locationActionButtonHtml(photo)}
                    ${deleteHtml}
                </div>
                <span class="photos-gallery-card__date">${dateOnly || '—'}</span>
            </div>
        </div>
    `;
}

function getSortedFilteredPhotos() {
    const photos = window.photosModule?.savedPhotos || [];
    const view = 'photos';
    const searchTerm = window.tableFilteringModule?.getSearchTerm() || '';
    let filteredPhotos = window.tableFilteringModule?.filterPhotos(photos, searchTerm) || photos;
    if (window.dataHubFiltersModule?.applyFilters) {
        filteredPhotos = window.dataHubFiltersModule.applyFilters(view, filteredPhotos);
    }
    if (window.photosBatchesPanelModule?.applyActiveBatchFilter) {
        filteredPhotos = window.photosBatchesPanelModule.applyActiveBatchFilter(filteredPhotos);
    }

    const sortState = window.tableSortingModule?.getSortStateForView
        ? window.tableSortingModule.getSortStateForView(view)
        : window.tableSortingModule?.getSortState() || { column: null, direction: 'asc' };
    return sortState.column && window.tableSortingModule?.sortData
        ? window.tableSortingModule.sortData(filteredPhotos, sortState.column, sortState.direction, view)
        : filteredPhotos;
}

function renderPhotosTable(tbody, emptyState) {
    const photos = window.photosModule?.savedPhotos || [];
    const selectedDataIds = window.dataSelectionModule?.selectedDataIds || new Set();
    const view = 'photos';
    const searchTerm = window.tableFilteringModule?.getSearchTerm() || '';
    const sortedPhotos = getSortedFilteredPhotos();

    const totalFiltered = sortedPhotos.length;
    if (totalFiltered === 0) {
        tbody.innerHTML = '';
        if (window.dataHubPaginationModule?.setPhotosPageItemIds) {
            window.dataHubPaginationModule.setPhotosPageItemIds([]);
        }
        if (window.dataHubPaginationModule?.clearDataHubPagination) {
            window.dataHubPaginationModule.clearDataHubPagination();
        }
        if (emptyState) {
            emptyState.style.display = 'block';
            const setEmpty =
                window.tableUtilsModule?.setDataTableEmptyMessage ||
                ((el, msg) => {
                    el.textContent = msg;
                });
            const batchActive = window.photosBatchesPanelModule?.getActiveBatchId?.();
            setEmpty(
                emptyState,
                photos.length === 0
                    ? 'No photos uploaded yet.'
                    : batchActive
                      ? 'No photos in this batch match your filters.'
                      : 'No photos match your search.'
            );
        }
        if (window.dataSelectionModule?.syncSelectAllDataCheckbox) {
            window.dataSelectionModule.syncSelectAllDataCheckbox();
        }
        return;
    }

    if (emptyState) {
        emptyState.style.display = 'none';
    }

    const pag = window.dataHubPaginationModule;
    if (pag) {
        pag.resetDataHubPageIfSearchChanged(view, searchTerm);
        let filterSig = window.dataHubFiltersModule?.getFilterSignature
            ? window.dataHubFiltersModule.getFilterSignature(view)
            : '';
        if (window.photosBatchesPanelModule?.getActiveBatchId) {
            filterSig += '|batch:' + (window.photosBatchesPanelModule.getActiveBatchId() || '');
        }
        pag.resetDataHubPageIfFiltersChanged(view, filterSig);
    }

    const pageSize = pag?.DATA_HUB_PHOTOS_PAGE_SIZE || 50;
    const slice = pag
        ? pag.paginateDataHubItems(view, sortedPhotos, pageSize)
        : {
              pageItems: sortedPhotos,
              totalItems: sortedPhotos.length,
              page: 1,
              totalPages: 1,
              rangeStart: 1,
              rangeEnd: sortedPhotos.length,
              pageSize,
          };

    const pagePhotos = slice.pageItems || [];
    if (pag?.setPhotosPageItemIds) {
        pag.setPhotosPageItemIds(pagePhotos.map((p) => p.id));
    }

    const dayGroupings = pag?.buildPhotosDayGroupings
        ? pag.buildPhotosDayGroupings(pagePhotos)
        : [{ type: 'day', bucket: { label: '', items: pagePhotos } }];

    let galleryInner = '';
    dayGroupings.forEach((entry) => {
        if (entry.type !== 'day') return;
        const bucket = entry.bucket || { label: '', items: [] };
        const items = bucket.items || [];
        const dayLabel = escapeHtmlText(bucket.label || 'No date');
        galleryInner += `
            <section class="photos-gallery-day">
                <header class="photos-gallery-day-header">
                    <span class="data-date-section-title">${dayLabel}</span>
                    <span class="data-date-section-count">(${items.length} photo${items.length !== 1 ? 's' : ''})</span>
                </header>
                <div class="photos-gallery-grid">
                    ${items.map((photo) => photoGalleryCard(photo, selectedDataIds)).join('')}
                </div>
            </section>
        `;
    });

    tbody.innerHTML = `
        <tr class="photos-gallery-row">
            <td class="photos-gallery-cell" colspan="6">
                <div class="photos-gallery" id="photosGalleryRoot">${galleryInner}</div>
            </td>
        </tr>
    `;

    if (pag) {
        pag.renderDataHubPagination(view, slice, {
            label: 'photo',
            labelPlural: 'photos',
            pageSize,
        });
    }
    if (window.photosModule && window.photosModule.setServerPhotoImageSources) {
        window.photosModule.setServerPhotoImageSources(tbody);
    }
    if (window.dataSelectionModule?.syncSelectAllDataCheckbox) {
        window.dataSelectionModule.syncSelectAllDataCheckbox();
    }
    if (window.photosGalleryDragSelectModule?.bind) {
        window.photosGalleryDragSelectModule.bind(tbody.querySelector('#photosGalleryRoot'));
    }
}

window.photosTableRenderer = {
    renderPhotosTable,
    buildPhotoInfoFields,
    getSortedFilteredPhotos,
};
