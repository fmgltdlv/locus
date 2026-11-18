// Table filtering module - Search and filter logic

// Filter annotations (text search only; types via dataHubFilters)
function filterAnnotations(annotations, searchTerm) {
    return annotations.filter((annotation) => {
        if (!searchTerm) return true;
        return (
            (annotation.name || '').toLowerCase().includes(searchTerm) ||
            (annotation.note || '').toLowerCase().includes(searchTerm) ||
            (annotation.type || '').toLowerCase().includes(searchTerm)
        );
    });
}

// Filter photos
function filterPhotos(photos, searchTerm) {
    if (!searchTerm) return photos;
    
    return photos.filter(photo => {
        const fileName = (photo.fileName || '').toLowerCase();
        const dateTime = (photo.exifData?.dateTime || '').toLowerCase();
        const note = (photo.note || '').toLowerCase();
        const tagMod = window.photoTagsModule;
        const tagLine = (tagMod && typeof tagMod.getPhotoTags === 'function' ? tagMod.getPhotoTags(photo) : [])
            .join(' ')
            .toLowerCase();
        return fileName.includes(searchTerm) || dateTime.includes(searchTerm) || note.includes(searchTerm) || tagLine.includes(searchTerm);
    });
}

// Filter documents
function filterDocuments(documents, searchTerm) {
    if (!searchTerm) return documents;
    
    return documents.filter(doc => {
        return (doc.fileName || '').toLowerCase().includes(searchTerm) ||
               (doc.originalFileName || '').toLowerCase().includes(searchTerm);
    });
}

// Filter reported events
function filterReportedEvents(events, searchTerm) {
    if (!searchTerm) return events;
    
    return events.filter(event => {
        return (event.ticketNumber || '').toLowerCase().includes(searchTerm) ||
               (event.name || '').toLowerCase().includes(searchTerm) ||
               (event.address || '').toLowerCase().includes(searchTerm) ||
               (event.utilityType || '').toLowerCase().includes(searchTerm) ||
               (event.description || '').toLowerCase().includes(searchTerm) ||
               (event.technicianName || '').toLowerCase().includes(searchTerm);
    });
}

// Filter data layers
function filterDataLayers(layers, searchTerm) {
    if (!searchTerm) return layers;
    
    return layers.filter(layer => {
        return (layer.name || '').toLowerCase().includes(searchTerm);
    });
}

// Get search term from input
function getSearchTerm() {
    return (document.getElementById('dataSearchInput')?.value || '').toLowerCase();
}

// Export module
window.tableFilteringModule = {
    filterAnnotations,
    filterPhotos,
    filterDocuments,
    filterReportedEvents,
    filterDataLayers,
    getSearchTerm,
};

