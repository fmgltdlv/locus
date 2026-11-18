/**
 * Minimal read-only full-size photo lightbox for public share (and other guests).
 */
(function (global) {
    'use strict';

    const STYLE_ID = 'photo-viewer-readonly-styles';
    const ROOT_ID = 'photoViewerReadOnlyRoot';

    let gallery = [];
    let index = 0;

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${ROOT_ID} {
                position: fixed; inset: 0; z-index: 10000;
                display: flex; align-items: center; justify-content: center;
                background: rgba(15, 23, 42, 0.82);
                padding: 1rem;
            }
            #${ROOT_ID}[hidden] { display: none !important; }
            #${ROOT_ID} .pvro-dialog {
                position: relative; max-width: min(96vw, 1200px); max-height: 92vh;
                display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
            }
            #${ROOT_ID} .pvro-img-wrap {
                max-width: 96vw; max-height: 80vh; display: flex; align-items: center; justify-content: center;
            }
            #${ROOT_ID} img {
                max-width: 96vw; max-height: 80vh; object-fit: contain;
                border-radius: 0.25rem; background: #0f172a;
            }
            #${ROOT_ID} .pvro-caption {
                color: #e2e8f0; font-size: 0.85rem; text-align: center;
            }
            #${ROOT_ID} .pvro-toolbar {
                display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center;
            }
            #${ROOT_ID} .pvro-toolbar button {
                border: 0; border-radius: 0.35rem; padding: 0.45rem 0.85rem;
                background: #e2e8f0; color: #0f172a; font-weight: 600; cursor: pointer;
            }
            #${ROOT_ID} .pvro-toolbar button:disabled { opacity: 0.4; cursor: default; }
            #${ROOT_ID} .pvro-close {
                position: absolute; top: -0.25rem; right: -0.25rem;
                width: 2rem; height: 2rem; border-radius: 999px; border: 0;
                background: #f8fafc; color: #0f172a; font-size: 1.25rem; cursor: pointer; line-height: 1;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureRoot() {
        ensureStyles();
        let root = document.getElementById(ROOT_ID);
        if (root) return root;
        root = document.createElement('div');
        root.id = ROOT_ID;
        root.hidden = true;
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.innerHTML =
            `<div class="pvro-dialog">` +
            `<button type="button" class="pvro-close" data-pvro-close aria-label="Close">&times;</button>` +
            `<div class="pvro-img-wrap"><img data-pvro-img alt=""></div>` +
            `<div class="pvro-caption" data-pvro-caption></div>` +
            `<div class="pvro-toolbar">` +
            `<button type="button" data-pvro-prev>Previous</button>` +
            `<button type="button" data-pvro-next>Next</button>` +
            `<button type="button" data-pvro-close>Close</button>` +
            `</div></div>`;
        document.body.appendChild(root);
        root.addEventListener('click', (e) => {
            if (e.target === root) close();
        });
        root.querySelectorAll('[data-pvro-close]').forEach((btn) => {
            btn.addEventListener('click', () => close());
        });
        const prev = root.querySelector('[data-pvro-prev]');
        const next = root.querySelector('[data-pvro-next]');
        if (prev) prev.addEventListener('click', () => step(-1));
        if (next) next.addEventListener('click', () => step(1));
        document.addEventListener('keydown', onKey);
        return root;
    }

    function onKey(e) {
        const root = document.getElementById(ROOT_ID);
        if (!root || root.hidden) return;
        if (e.key === 'Escape') close();
        if (e.key === 'ArrowLeft') step(-1);
        if (e.key === 'ArrowRight') step(1);
    }

    function step(delta) {
        if (gallery.length < 2) return;
        index = (index + delta + gallery.length) % gallery.length;
        render();
    }

    function render() {
        const root = ensureRoot();
        const item = gallery[index] || null;
        const img = root.querySelector('[data-pvro-img]');
        const caption = root.querySelector('[data-pvro-caption]');
        const prev = root.querySelector('[data-pvro-prev]');
        const next = root.querySelector('[data-pvro-next]');
        if (!item || !img) return;
        img.removeAttribute('src');
        img.alt = item.fileName || 'Photo';
        img.src = item.url || '';
        if (caption) {
            const pos = gallery.length > 1 ? ` (${index + 1} / ${gallery.length})` : '';
            caption.textContent = (item.fileName || 'Photo') + pos;
        }
        if (prev) prev.disabled = gallery.length < 2;
        if (next) next.disabled = gallery.length < 2;
        root.hidden = false;
    }

    function close() {
        const root = document.getElementById(ROOT_ID);
        if (root) {
            root.hidden = true;
            const img = root.querySelector('[data-pvro-img]');
            if (img) img.removeAttribute('src');
        }
        gallery = [];
        index = 0;
    }

    /**
     * @param {string|object} urlOrItem string URL or { url, fileName }
     * @param {string} [fileName]
     * @param {{ gallery?: Array<{url:string,fileName?:string}>, galleryIndex?: number }} [ctx]
     */
    function open(urlOrItem, fileName, ctx) {
        if (ctx && Array.isArray(ctx.gallery) && ctx.gallery.length) {
            gallery = ctx.gallery
                .map((g) => {
                    if (!g) return null;
                    if (typeof g === 'string') return { url: g, fileName: fileName || 'Photo' };
                    return {
                        url: g.url || g.fileUrl || '',
                        fileName: g.fileName || fileName || 'Photo',
                    };
                })
                .filter((g) => g && g.url);
            index = Math.max(0, Math.min(Number(ctx.galleryIndex) || 0, gallery.length - 1));
        } else {
            const url =
                typeof urlOrItem === 'string'
                    ? urlOrItem
                    : urlOrItem && (urlOrItem.url || urlOrItem.fileUrl)
                      ? urlOrItem.url || urlOrItem.fileUrl
                      : '';
            const name =
                fileName ||
                (urlOrItem && typeof urlOrItem === 'object' && urlOrItem.fileName) ||
                'Photo';
            if (!url) return;
            gallery = [{ url, fileName: name }];
            index = 0;
        }
        if (!gallery.length) return;
        render();
    }

    global.photoViewerReadOnly = {
        open,
        close,
    };
})(typeof window !== 'undefined' ? window : globalThis);
