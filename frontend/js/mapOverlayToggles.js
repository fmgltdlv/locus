// Shared map layer panel overlay toggles (Tickets, Drone Maps, Photos).

const OverlayToggleRegistry = globalThis.Map;
let overlayToggleStates = null;

const OVERLAY_PANEL_META = {
    tickets: { className: 'overlay-tickets' },
    'drone-maps': { className: 'overlay-drone-maps' },
    photos: { className: 'overlay-photos' },
};

const OVERLAY_PANEL_ORDER = ['tickets', 'drone-maps', 'photos'];

function getOverlayToggleStates() {
    if (!overlayToggleStates) {
        overlayToggleStates = new OverlayToggleRegistry();
    }
    return overlayToggleStates;
}

function getLayerPanel() {
    return window.layerControlPanel || null;
}

function translate(label) {
    return window.t ? window.t(label) : label;
}

function ensureOverlaySectionHeader() {
    const panel = getLayerPanel();
    if (!panel || typeof L === 'undefined') return false;

    if (!panel.querySelector('.layer-divider')) {
        L.DomUtil.create('div', 'layer-divider', panel);
    }

    if (!panel.querySelector('.overlay-title-container')) {
        const overlayTitleContainer = L.DomUtil.create('div', 'overlay-title-container', panel);
        const overlayTitle = L.DomUtil.create('div', 'overlay-title', overlayTitleContainer);
        overlayTitle.textContent = translate('Overlays');

        const clearLayersButton = L.DomUtil.create('button', 'clear-layers-button', overlayTitleContainer);
        clearLayersButton.textContent = translate('Clear Layers');
        clearLayersButton.title = translate('Clear all overlay layers');

        L.DomEvent.on(clearLayersButton, 'click', function (e) {
            L.DomEvent.stopPropagation(e);
            L.DomEvent.preventDefault(e);
            if (window.layerManagerModule && window.layerManagerModule.clearAllOverlayLayers) {
                window.layerManagerModule.clearAllOverlayLayers();
            }
        });
        L.DomEvent.disableClickPropagation(clearLayersButton);
    }

    return true;
}

function insertOverlayPanelOption(overlayOption, id) {
    const panel = getLayerPanel();
    if (!panel) return;

    const index = OVERLAY_PANEL_ORDER.indexOf(id);
    if (index === -1) {
        panel.appendChild(overlayOption);
        return;
    }

    for (let i = index + 1; i < OVERLAY_PANEL_ORDER.length; i++) {
        const nextMeta = OVERLAY_PANEL_META[OVERLAY_PANEL_ORDER[i]];
        const nextEl = nextMeta ? panel.querySelector('.' + nextMeta.className) : null;
        if (nextEl) {
            nextEl.insertAdjacentElement('beforebegin', overlayOption);
            return;
        }
    }

    for (let i = index - 1; i >= 0; i--) {
        const prevMeta = OVERLAY_PANEL_META[OVERLAY_PANEL_ORDER[i]];
        const prevEl = prevMeta ? panel.querySelector('.' + prevMeta.className) : null;
        if (prevEl) {
            prevEl.insertAdjacentElement('afterend', overlayOption);
            return;
        }
    }

    panel.appendChild(overlayOption);
}

/**
 * Create a layer-panel overlay checkbox once.
 * @param {{ id: string, label: string, onToggle: (active: boolean) => void, getActive?: () => boolean }} opts
 */
function createMapOverlayToggle(opts) {
    const panel = getLayerPanel();
    if (!panel || !opts || !opts.id || typeof L === 'undefined') return null;
    if (window.CORE_PRODUCT === true && (opts.id === 'drone-maps' || opts.id === 'photos')) {
        return null;
    }

    const states = getOverlayToggleStates();
    const meta = OVERLAY_PANEL_META[opts.id] || { className: 'overlay-' + opts.id };
    const existing = states.get(opts.id);
    if (existing) {
        syncMapOverlayToggle(opts.id, opts.getActive ? !!opts.getActive() : false);
        return existing;
    }

    ensureOverlaySectionHeader();

    const overlayOption = L.DomUtil.create('div', 'layer-option ' + meta.className);

    const checkbox = L.DomUtil.create('input', '', overlayOption);
    checkbox.type = 'checkbox';
    checkbox.id = opts.id + '-overlay';
    checkbox.checked = opts.getActive ? !!opts.getActive() : false;

    const label = L.DomUtil.create('label', '', overlayOption);
    label.textContent = translate(opts.label);
    label.setAttribute('for', checkbox.id);

    const state = {
        checkbox,
        overlayOption,
        onToggle: typeof opts.onToggle === 'function' ? opts.onToggle : function () {},
        getActive: typeof opts.getActive === 'function' ? opts.getActive : function () { return false; },
    };

    L.DomEvent.on(checkbox, 'click', function (e) {
        L.DomEvent.stopPropagation(e);
        e.stopImmediatePropagation();
        const next = checkbox.checked;
        state.onToggle(next);
        syncMapOverlayToggle(opts.id, next);
    });

    L.DomEvent.disableClickPropagation(overlayOption);
    insertOverlayPanelOption(overlayOption, opts.id);
    states.set(opts.id, state);
    syncMapOverlayToggle(opts.id, state.getActive());
    return state;
}

function syncMapOverlayToggle(id, active) {
    const state = getOverlayToggleStates().get(id);
    if (!state || !state.checkbox) return;
    state.checkbox.checked = !!active;
}

function removeMapOverlayToggle(id) {
    const states = getOverlayToggleStates();
    const state = states.get(id);
    if (!state) return;
    if (state.overlayOption && state.overlayOption.parentNode) {
        state.overlayOption.parentNode.removeChild(state.overlayOption);
    }
    states.delete(id);
}

function getMapOverlayToggleActive(id) {
    const state = getOverlayToggleStates().get(id);
    if (!state) return false;
    return !!state.getActive();
}

function toggleMapOverlayById(id) {
    const state = getOverlayToggleStates().get(id);
    if (!state) return;
    const next = !state.getActive();
    state.onToggle(next);
    syncMapOverlayToggle(id, next);
}

window.mapOverlayTogglesModule = {
    createMapOverlayToggle,
    syncMapOverlayToggle,
    removeMapOverlayToggle,
    getMapOverlayToggleActive,
    toggleMapOverlayById,
};
