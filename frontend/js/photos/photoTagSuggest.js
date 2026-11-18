/**
 * Comma-token autosuggest for photo tags input.
 * @param {HTMLInputElement} inputEl
 * @param {{ getVocabulary: () => string[], getExcludeTags: () => string[], onChange?: () => void }} options
 */
function bindPhotoTagSuggestInput(inputEl, options) {
    if (!inputEl || inputEl.dataset.photoTagSuggestBound === '1') return;
    inputEl.dataset.photoTagSuggestBound = '1';
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('spellcheck', 'false');

    const opts = options && typeof options === 'object' ? options : {};
    let listEl = null;
    let activeIndex = -1;
    let currentMatches = [];

    function getVocabulary() {
        if (typeof opts.getVocabulary === 'function') return opts.getVocabulary() || [];
        const mod = window.photoTagsModule;
        return mod && typeof mod.buildPhotoTagVocabulary === 'function'
            ? mod.buildPhotoTagVocabulary([])
            : [];
    }

    function getExcludeTags() {
        if (typeof opts.getExcludeTags === 'function') return opts.getExcludeTags() || [];
        const mod = window.photoTagsModule;
        if (!mod || typeof mod.normalizePhotoTags !== 'function') return [];
        const parts = String(inputEl.value || '').split(',');
        parts.pop();
        return mod.normalizePhotoTags(parts);
    }

    function getActiveToken() {
        const val = String(inputEl.value || '');
        const idx = val.lastIndexOf(',');
        return idx === -1 ? val.trim() : val.slice(idx + 1).trim();
    }

    function removeList() {
        if (listEl && listEl.parentNode) listEl.parentNode.removeChild(listEl);
        listEl = null;
        activeIndex = -1;
        currentMatches = [];
    }

    function renderList() {
        removeList();
        const mod = window.photoTagsModule;
        if (!mod || typeof mod.getOrgPhotoTagSuggestions !== 'function') return;

        const partial = getActiveToken();
        currentMatches = mod.getOrgPhotoTagSuggestions(partial, getExcludeTags(), getVocabulary());
        if (!currentMatches.length) return;

        listEl = document.createElement('div');
        listEl.className = 'photo-tag-suggest-list';
        listEl.setAttribute('role', 'listbox');

        currentMatches.forEach(function (item, index) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className =
                'photo-tag-suggest-item' +
                (item.preset ? ' photo-tag-suggest-item--preset' : '') +
                (index === activeIndex ? ' photo-tag-suggest-item--active' : '');
            btn.setAttribute('role', 'option');
            btn.textContent = item.tag;
            btn.addEventListener('mousedown', function (ev) {
                ev.preventDefault();
                acceptSuggestion(item.tag);
            });
            listEl.appendChild(btn);
        });

        const wrap = inputEl.closest('.photo-tag-input-wrap') || inputEl.parentElement;
        if (wrap) {
            if (!wrap.classList.contains('photo-tag-input-wrap')) {
                wrap.classList.add('photo-tag-input-wrap');
            }
            wrap.appendChild(listEl);
        }
    }

    function acceptSuggestion(tag) {
        const mod = window.photoTagsModule;
        const existing = mod && typeof mod.normalizePhotoTags === 'function' ? mod.normalizePhotoTags(getExcludeTags()) : [];
        const nextTags = existing.concat([tag]);
        inputEl.value =
            (mod && typeof mod.formatPhotoTagsForInput === 'function'
                ? mod.formatPhotoTagsForInput(nextTags)
                : nextTags.join(', ')) + ', ';
        removeList();
        inputEl.focus();
        if (typeof opts.onChange === 'function') opts.onChange();
    }

    function highlightActive() {
        if (!listEl) return;
        const items = listEl.querySelectorAll('.photo-tag-suggest-item');
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('photo-tag-suggest-item--active', i === activeIndex);
        }
    }

    inputEl.addEventListener('input', function () {
        renderList();
        if (typeof opts.onChange === 'function') opts.onChange();
    });

    inputEl.addEventListener('focus', function () {
        renderList();
    });

    inputEl.addEventListener('blur', function () {
        setTimeout(removeList, 150);
    });

    inputEl.addEventListener('keydown', function (ev) {
        if (!listEl || !currentMatches.length) {
            if (ev.key === 'Escape') removeList();
            return;
        }
        if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1);
            highlightActive();
        } else if (ev.key === 'ArrowUp') {
            ev.preventDefault();
            activeIndex = Math.max(activeIndex - 1, 0);
            highlightActive();
        } else if (ev.key === 'Enter' || ev.key === 'Tab') {
            if (activeIndex >= 0 && currentMatches[activeIndex]) {
                ev.preventDefault();
                acceptSuggestion(currentMatches[activeIndex].tag);
            }
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            removeList();
        }
    });
}

/**
 * Quick-pick preset chips below tags input.
 * @param {HTMLElement} container
 * @param {HTMLInputElement} inputEl
 * @param {{ onChange?: () => void }} [options]
 */
function bindPhotoTagQuickPickChips(container, inputEl, options) {
    if (!container || !inputEl) return;
    container.innerHTML = '';
    const mod = window.photoTagsModule;
    if (!mod || !Array.isArray(mod.PHOTO_PRESET_TAGS)) return;

    mod.PHOTO_PRESET_TAGS.forEach(function (preset) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'photo-tag-chip photo-tag-chip--preset photo-tag-quick-pick-chip';
        chip.textContent = preset;
        chip.addEventListener('click', function () {
            const current = mod.normalizePhotoTags(String(inputEl.value || '').replace(/,\s*$/, ''));
            if (mod.photoHasTag({ tags: current }, preset)) return;
            current.push(preset);
            inputEl.value = mod.formatPhotoTagsForInput(current) + ', ';
            inputEl.focus();
            if (options && typeof options.onChange === 'function') options.onChange();
        });
        container.appendChild(chip);
    });
}

window.bindPhotoTagSuggestInput = bindPhotoTagSuggestInput;
window.bindPhotoTagQuickPickChips = bindPhotoTagQuickPickChips;
