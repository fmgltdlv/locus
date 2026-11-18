// Icon module - Icon definitions and HTML generation

// Icon definitions
const ICON_DEFINITIONS = [
    { id: 'circle', name: 'Circle', emoji: '●', colored: true },
    { id: 'square', name: 'Square', emoji: '■', colored: true },
    { id: 'triangle', name: 'Triangle', emoji: '▲', colored: true },
    { id: 'star', name: 'Star', emoji: '★', colored: true },
    { id: 'pin', name: 'Pin', emoji: '📍', colored: true },
    { id: 'checkmark', name: 'Checkmark (Good)', emoji: '✓', colored: false, fixedColor: '#10b981' },
    { id: 'x', name: 'X (Bad)', emoji: '✗', colored: false, fixedColor: 'var(--app-danger)' },
    { id: 'warning', name: 'Warning', emoji: '⚠', colored: false, fixedColor: '#f59e0b' },
    { id: 'info', name: 'Info', emoji: 'ℹ', colored: false, fixedColor: 'var(--app-accent)' },
    { id: 'none', name: 'No Icon (Lines/Polygons only)', emoji: '—', colored: false, fixedColor: '#666666' }
];

const EXCAVATION_WHITE_PAD_PX = 4;

/** Outer pixel size and anchor for Leaflet divIcon (inner size + white padding when excavation). */
function getMapIconLayout(options) {
    options = options || {};
    const inner = options.size != null ? options.size : 24;
    const pad = options.excavationPadding ? EXCAVATION_WHITE_PAD_PX * 2 : 0;
    const total = inner + pad;
    const anchor = total / 2;
    return { size: Math.round(total), anchor };
}

function wrapExcavationPadding(innerHtml, borderRadius) {
    return `<span style="display: inline-block; padding: ${EXCAVATION_WHITE_PAD_PX}px; background: var(--app-text-inverse); border-radius: ${borderRadius}; box-shadow: 0 2px 5px rgba(0,0,0,0.35); line-height: 0; vertical-align: middle;">${innerHtml}</span>`;
}

// Helper function to get icon HTML
// options: { excavationPadding?: boolean, size?: number } — extra white padding for Proposed Excavation map icons
function getIconHTML(iconType, color, options) {
    options = options || {};
    const pad = !!options.excavationPadding;
    const iconDef = ICON_DEFINITIONS.find(i => i.id === iconType) || ICON_DEFINITIONS[0];
    const iconColor = iconDef.colored ? color : iconDef.fixedColor;
    const size = options.size != null ? options.size : 24;
    const innerShadow = pad ? 'none' : '0 2px 4px rgba(0,0,0,0.3)';
    const whiteBorder = pad ? 'none' : '2px solid white';

    let html = '';
    switch (iconType) {
        case 'circle':
            html = `<div style="background-color: ${iconColor}; width: ${size}px; height: ${size}px; border-radius: 50%; border: ${whiteBorder}; box-shadow: ${innerShadow};"></div>`;
            if (pad) html = wrapExcavationPadding(html, '50%');
            break;
        case 'square':
            html = `<div style="background-color: ${iconColor}; width: ${size}px; height: ${size}px; border: ${whiteBorder}; box-shadow: ${innerShadow};"></div>`;
            if (pad) html = wrapExcavationPadding(html, '4px');
            break;
        case 'triangle':
            html = `<div style="width: 0; height: 0; border-left: ${size / 2}px solid transparent; border-right: ${size / 2}px solid transparent; border-bottom: ${size}px solid ${iconColor}; filter: ${pad ? 'none' : 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))'};"></div>`;
            if (pad) html = wrapExcavationPadding(html, '4px');
            break;
        case 'star':
            html = `<div style="color: ${iconColor}; font-size: ${size}px; text-shadow: ${pad ? 'none' : '0 2px 4px rgba(0,0,0,0.3)'};">★</div>`;
            if (pad) html = wrapExcavationPadding(html, '4px');
            break;
        case 'pin':
            html = `<div style="color: ${iconColor}; font-size: ${size}px; text-shadow: ${pad ? 'none' : '0 2px 4px rgba(0,0,0,0.3)'};">📍</div>`;
            if (pad) html = wrapExcavationPadding(html, '4px');
            break;
        case 'checkmark':
            html = `<div style="background-color: ${iconColor}; width: ${size}px; height: ${size}px; border-radius: 50%; border: ${whiteBorder}; box-shadow: ${innerShadow}; display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ${size * 0.6}px; font-weight: bold;">✓</div>`;
            if (pad) html = wrapExcavationPadding(html, '50%');
            break;
        case 'x':
            html = `<div style="background-color: ${iconColor}; width: ${size}px; height: ${size}px; border-radius: 50%; border: ${whiteBorder}; box-shadow: ${innerShadow}; display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ${size * 0.6}px; font-weight: bold;">✗</div>`;
            if (pad) html = wrapExcavationPadding(html, '50%');
            break;
        case 'warning':
            html = `<div style="background-color: ${iconColor}; width: ${size}px; height: ${size}px; border-radius: 50%; border: ${whiteBorder}; box-shadow: ${innerShadow}; display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ${size * 0.6}px; font-weight: bold;">⚠</div>`;
            if (pad) html = wrapExcavationPadding(html, '50%');
            break;
        case 'info':
            html = `<div style="background-color: ${iconColor}; width: ${size}px; height: ${size}px; border-radius: 50%; border: ${whiteBorder}; box-shadow: ${innerShadow}; display: flex; align-items: center; justify-content: center; color: var(--app-text-inverse); font-size: ${size * 0.6}px; font-weight: bold;">ℹ</div>`;
            if (pad) html = wrapExcavationPadding(html, '50%');
            break;
        default:
            html = `<div style="background-color: ${iconColor}; width: ${size}px; height: ${size}px; border-radius: 50%; border: ${whiteBorder}; box-shadow: ${innerShadow};"></div>`;
            if (pad) html = wrapExcavationPadding(html, '50%');
    }
    return html;
}

// Generate icon picker HTML
function generateIconPickerHTML(selectedIcon, selectedColor) {
    return ICON_DEFINITIONS.map(icon => {
        const iconColor = icon.colored ? selectedColor : icon.fixedColor;
        const iconContent = icon.id === 'none' ? '—' : icon.emoji;
        const buttonStyle = icon.id === 'none'
            ? `width: 40px; height: 40px; border-radius: 4px; background: ${iconColor}; 
               border: ${selectedIcon === icon.id ? '3px solid #1f2937' : '2px solid #404040'}; 
               cursor: pointer; box-shadow: ${selectedIcon === icon.id ? '0 0 0 2px rgba(59, 130, 246, 0.3)' : 'none'};
               display: flex; align-items: center; justify-content: center; font-size: 16px; color: var(--app-text-inverse); font-weight: bold;
               line-height: 1; padding: 0; margin: 0;`
            : `width: 40px; height: 40px; border-radius: 4px; background: ${iconColor}; 
               border: ${selectedIcon === icon.id ? '3px solid #1f2937' : '2px solid #404040'}; 
               cursor: pointer; box-shadow: ${selectedIcon === icon.id ? '0 0 0 2px rgba(59, 130, 246, 0.3)' : 'none'};
               display: flex; align-items: center; justify-content: center; font-size: 20px; color: var(--app-text-inverse);
               line-height: 1; padding: 0; margin: 0;`;
        return `
            <button onclick="selectAnnotationIcon('${icon.id}')" 
                    style="${buttonStyle}"
                    title="${icon.name}">${iconContent}</button>
        `;
    }).join('');
}

// Export for use in other modules
window.iconsModule = {
    ICON_DEFINITIONS,
    getIconHTML,
    generateIconPickerHTML,
    getMapIconLayout,
    EXCAVATION_WHITE_PAD_PX
};
