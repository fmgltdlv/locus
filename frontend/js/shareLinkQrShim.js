import QRCode from 'qrcode';

if (typeof window !== 'undefined') {
    /**
     * Encode a URL as a QR data URL (PNG).
     * @param {string} url
     * @param {{ width?: number, margin?: number }} [opts]
     * @returns {Promise<string>}
     */
    window.__shareLinkQrToDataUrl = async function (url, opts) {
        const width = opts && opts.width != null ? opts.width : 220;
        const margin = opts && opts.margin != null ? opts.margin : 2;
        return QRCode.toDataURL(String(url || ''), {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            margin,
            width,
            color: { dark: '#0f172a', light: '#ffffff' },
        });
    };
}
