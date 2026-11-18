import html2canvas from 'html2canvas';

if (typeof window !== 'undefined') {
    /**
     * Capture an element as a PNG data URL.
     * @param {HTMLElement} el
     * @param {{ scale?: number, backgroundColor?: string|null }} [opts]
     * @returns {Promise<string>}
     */
    window.__sharePageCaptureToDataUrl = async function (el, opts) {
        if (!el) throw new Error('Nothing to capture');
        const scale = opts && opts.scale != null ? opts.scale : Math.min(2, window.devicePixelRatio || 1);
        const backgroundColor =
            opts && Object.prototype.hasOwnProperty.call(opts, 'backgroundColor')
                ? opts.backgroundColor
                : '#ffffff';
        const canvas = await html2canvas(el, {
            scale,
            useCORS: true,
            allowTaint: false,
            logging: false,
            backgroundColor,
            // Leaflet tiles / markers live in nested canvases & transforms.
            foreignObjectRendering: false,
            removeContainer: true,
        });
        return canvas.toDataURL('image/png');
    };
}
