// Utility Types module - APWA color codes and utility type definitions

// APWA (American Public Works Association) color codes for utilities
const UTILITY_COLORS = {
    'Gas': '#FFFF00',           // Yellow
    'Power': '#FF0000',         // Red (Electric)
    'Electric': '#FF0000',      // Red
    'Comm': '#FFA500',          // Orange (Communications)
    'Communications': '#FFA500', // Orange
    'Sewer': '#008000',         // Green
    'Water': '#2693d1',         // Blue
    'Survey': '#FF69B4',        // Pink (Temporary Survey)
    'Reclaimed Water': '#e7bef8', // Light Purple
    'Storm Drain': '#66b266',   // Light Green
    'Proposed Excavation': '#FFFFFF', // White
    'Other': '#ffc0cb'          // Light Pink
};

/** Saved data layer label when annotations use more than one utility type (not editable in the data table). */
const DATA_LAYER_UTILITY_VARIOUS = 'Various';

// Utility type options for user selection
const UTILITY_TYPE_OPTIONS = [
    'Gas',
    'Power',
    'Comm',
    'Sewer',
    'Water',
    'Survey',
    'Reclaimed Water',
    'Storm Drain',
    'Proposed Excavation',
    'Other'
];

// Get utility type from color (reverse lookup)
function getUtilityTypeFromColor(color) {
    if (!color) return 'Other';
    
    // Normalize color to uppercase for comparison
    const normalizedColor = color.toUpperCase();
    
    // Find matching utility type
    for (const [utilityType, utilityColor] of Object.entries(UTILITY_COLORS)) {
        if (utilityColor.toUpperCase() === normalizedColor) {
            return utilityType;
        }
    }
    
    return 'Other';
}

// Get color from utility type
function getColorFromUtilityType(utilityType) {
    if (!utilityType) return '#2563eb'; // Default blue
    if (utilityType === DATA_LAYER_UTILITY_VARIOUS) return '#6b7280'; // neutral gray for display only
    return UTILITY_COLORS[utilityType] || UTILITY_COLORS['Other'];
}

/** Single utility type string if all annotations share it (including all blank); otherwise Various. */
function deriveDataLayerUtilityTypeFromAnnotations(annotations) {
    if (!annotations || annotations.length === 0) return '';
    const seen = new Set();
    for (let i = 0; i < annotations.length; i++) {
        const ann = annotations[i];
        const u = ann && ann.utilityType != null ? String(ann.utilityType).trim() : '';
        seen.add(u);
    }
    if (seen.size <= 1) return [...seen][0];
    return DATA_LAYER_UTILITY_VARIOUS;
}

/** Map icon fill: Proposed Excavation keeps white line/polygon color but uses black icons for visibility. */
function getAnnotationIconColor(utilityType, annotationColor) {
    if (utilityType === 'Proposed Excavation') return '#000000';
    return annotationColor || '#2563eb';
}

// Export for use in other modules
window.utilityTypesModule = {
    UTILITY_COLORS,
    UTILITY_TYPE_OPTIONS,
    DATA_LAYER_UTILITY_VARIOUS,
    getUtilityTypeFromColor,
    getColorFromUtilityType,
    getAnnotationIconColor,
    deriveDataLayerUtilityTypeFromAnnotations
};

