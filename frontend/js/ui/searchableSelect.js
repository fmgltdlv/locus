/**
 * Searchable combobox wrapper for large native <select> lists (#163).
 * Desktop: inline searchable dropdown. Mobile: bottom-sheet popup picker.
 */
(function () {
    let mobileOverlay = null;
    let mobileState = null;

    function isMobileSearchableSelectViewport() {
        return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
    }

    function removeList(wrap) {
        const listEl = wrap && wrap.querySelector('.searchable-select-list');
        if (listEl && listEl.parentNode) listEl.parentNode.removeChild(listEl);
    }

    function getSelectLabelText(selectEl) {
        if (!selectEl || !selectEl.id) return '';
        const label = document.querySelector('label[for="' + String(selectEl.id).replace(/"/g, '') + '"]');
        return label ? String(label.textContent || '').trim() : '';
    }

    function getPlaceholder(selectEl, options) {
        return (
            selectEl.getAttribute('data-search-placeholder') ||
            (options && options.placeholder) ||
            'Search…'
        );
    }

    function getPickerTitle(selectEl, options) {
        return (
            (options && options.title) ||
            selectEl.getAttribute('data-search-title') ||
            getSelectLabelText(selectEl) ||
            'Select option'
        );
    }

    function syncInputFromSelect(selectEl, input) {
        if (!selectEl || !input) return;
        const opt = selectEl.options[selectEl.selectedIndex];
        input.value = opt && opt.value ? opt.text : '';
    }

    function syncTriggerFromSelect(selectEl, trigger) {
        if (!selectEl || !trigger) return;
        const opt = selectEl.options[selectEl.selectedIndex];
        const text = opt && opt.value ? opt.text : '';
        const placeholder = getPlaceholder(selectEl, null);
        trigger.textContent = text || placeholder;
        trigger.classList.toggle('searchable-select-trigger--placeholder', !text);
    }

    function getSelectableOptions(selectEl) {
        return Array.from(selectEl.options || []).filter(function (o) {
            return o.value !== '';
        });
    }

    function teardownSearchableSelect(selectEl) {
        if (!selectEl) return;
        if (mobileState && mobileState.selectEl === selectEl) {
            closeMobilePicker();
        }
        const wrap = selectEl.closest('.searchable-select-wrap');
        if (!wrap) return;
        const parent = wrap.parentNode;
        if (parent) parent.insertBefore(selectEl, wrap);
        wrap.remove();
        selectEl.classList.remove('searchable-select-native');
        selectEl.removeAttribute('tabindex');
        delete selectEl.dataset.searchableSelectBound;
        delete selectEl.dataset.searchableSelectMode;
    }

    function ensureMobileOverlay() {
        if (mobileOverlay) return mobileOverlay;
        mobileOverlay = document.createElement('div');
        mobileOverlay.className = 'searchable-select-mobile-overlay';
        mobileOverlay.setAttribute('aria-hidden', 'true');
        mobileOverlay.innerHTML =
            '<div class="searchable-select-mobile-panel" role="dialog" aria-modal="true">' +
            '<div class="searchable-select-mobile-header">' +
            '<h3 class="searchable-select-mobile-title"></h3>' +
            '<button type="button" class="searchable-select-mobile-close">Cancel</button>' +
            '</div>' +
            '<input type="search" class="searchable-select-mobile-search form-input" autocomplete="off" autocorrect="off" spellcheck="false" inputmode="search" enterkeyhint="search" placeholder="Search…">' +
            '<div class="searchable-select-mobile-list" role="listbox"></div>' +
            '</div>';
        document.body.appendChild(mobileOverlay);

        const panel = mobileOverlay.querySelector('.searchable-select-mobile-panel');
        const closeBtn = mobileOverlay.querySelector('.searchable-select-mobile-close');
        const searchInput = mobileOverlay.querySelector('.searchable-select-mobile-search');

        mobileOverlay.addEventListener('click', function (ev) {
            if (ev.target === mobileOverlay) closeMobilePicker();
        });
        if (closeBtn) closeBtn.addEventListener('click', closeMobilePicker);
        if (panel) {
            panel.addEventListener('click', function (ev) {
                ev.stopPropagation();
            });
        }
        if (searchInput) {
            searchInput.addEventListener('input', function () {
                if (mobileState) renderMobileList(mobileState.selectEl, searchInput.value);
            });
        }
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && mobileState) closeMobilePicker();
        });

        return mobileOverlay;
    }

    function closeMobilePicker() {
        if (!mobileOverlay) return;
        mobileOverlay.classList.remove('is-open');
        mobileOverlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('searchable-select-mobile-open');
        mobileState = null;
    }

    function renderMobileList(selectEl, filterText) {
        if (!mobileOverlay || !selectEl) return;
        const listEl = mobileOverlay.querySelector('.searchable-select-mobile-list');
        if (!listEl) return;
        const q = String(filterText || '')
            .trim()
            .toLowerCase();
        const matches = getSelectableOptions(selectEl).filter(function (opt) {
            if (!q) return true;
            return String(opt.text || '')
                .toLowerCase()
                .indexOf(q) !== -1;
        });
        listEl.innerHTML = '';
        if (!matches.length) {
            const empty = document.createElement('p');
            empty.className = 'searchable-select-mobile-empty';
            empty.textContent = q ? 'No matches' : 'No options';
            listEl.appendChild(empty);
            return;
        }
        matches.forEach(function (opt) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'searchable-select-mobile-item';
            btn.setAttribute('role', 'option');
            btn.textContent = opt.text;
            if (String(selectEl.value) === String(opt.value)) {
                btn.classList.add('searchable-select-mobile-item--selected');
                btn.setAttribute('aria-selected', 'true');
            }
            btn.addEventListener('click', function () {
                selectMobileOption(opt);
            });
            listEl.appendChild(btn);
        });
    }

    function selectMobileOption(opt) {
        if (!mobileState || !opt) return;
        const selectEl = mobileState.selectEl;
        const options = mobileState.options;
        const trigger = mobileState.trigger;
        selectEl.value = opt.value;
        if (trigger) syncTriggerFromSelect(selectEl, trigger);
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        if (options && typeof options.onChange === 'function') options.onChange();
        closeMobilePicker();
    }

    function openMobilePicker(selectEl, options, trigger) {
        if (!selectEl || selectEl.disabled) return;
        ensureMobileOverlay();
        mobileState = { selectEl: selectEl, options: options, trigger: trigger };
        const titleEl = mobileOverlay.querySelector('.searchable-select-mobile-title');
        const searchInput = mobileOverlay.querySelector('.searchable-select-mobile-search');
        if (titleEl) titleEl.textContent = getPickerTitle(selectEl, options);
        if (searchInput) {
            searchInput.value = '';
            renderMobileList(selectEl, '');
        } else {
            renderMobileList(selectEl, '');
        }
        mobileOverlay.classList.add('is-open');
        mobileOverlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('searchable-select-mobile-open');
        if (searchInput) {
            setTimeout(function () {
                searchInput.focus();
            }, 50);
        }
    }

    function bindMobileSearchableSelect(selectEl, options) {
        selectEl.dataset.searchableSelectMode = 'mobile';

        const wrap = document.createElement('div');
        wrap.className = 'searchable-select-wrap searchable-select-wrap--mobile';
        selectEl.parentNode.insertBefore(wrap, selectEl);
        wrap.appendChild(selectEl);

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'searchable-select-trigger form-input';
        trigger.setAttribute('aria-haspopup', 'dialog');
        if (selectEl.disabled) trigger.disabled = true;
        syncTriggerFromSelect(selectEl, trigger);
        wrap.insertBefore(trigger, selectEl);

        selectEl.classList.add('searchable-select-native');
        selectEl.tabIndex = -1;

        trigger.addEventListener('click', function () {
            openMobilePicker(selectEl, options, trigger);
        });

        selectEl.addEventListener('change', function () {
            syncTriggerFromSelect(selectEl, trigger);
        });
    }

    function bindDesktopSearchableSelect(selectEl, options) {
        selectEl.dataset.searchableSelectMode = 'desktop';

        const wrap = document.createElement('div');
        wrap.className = 'searchable-select-wrap searchable-select-wrap--desktop';
        selectEl.parentNode.insertBefore(wrap, selectEl);
        wrap.appendChild(selectEl);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'form-input searchable-select-input';
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-haspopup', 'listbox');
        input.placeholder = getPlaceholder(selectEl, options);
        if (selectEl.disabled) input.disabled = true;
        wrap.insertBefore(input, selectEl);

        selectEl.classList.add('searchable-select-native');
        selectEl.tabIndex = -1;
        syncInputFromSelect(selectEl, input);

        let activeIndex = -1;
        let currentMatches = [];

        function selectOption(opt) {
            selectEl.value = opt.value;
            input.value = opt.text;
            removeList(wrap);
            input.setAttribute('aria-expanded', 'false');
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            if (options && typeof options.onChange === 'function') options.onChange();
        }

        function renderList(filterText) {
            removeList(wrap);
            const q = String(filterText || '')
                .trim()
                .toLowerCase();
            currentMatches = getSelectableOptions(selectEl).filter(function (opt) {
                if (!q) return true;
                return String(opt.text || '')
                    .toLowerCase()
                    .indexOf(q) !== -1;
            });
            if (!currentMatches.length) {
                input.setAttribute('aria-expanded', 'false');
                return;
            }
            activeIndex = -1;
            const listEl = document.createElement('div');
            listEl.className = 'searchable-select-list photo-tag-suggest-list';
            listEl.setAttribute('role', 'listbox');
            currentMatches.forEach(function (opt, index) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'searchable-select-item photo-tag-suggest-item';
                btn.setAttribute('role', 'option');
                btn.textContent = opt.text;
                btn.addEventListener('mousedown', function (ev) {
                    ev.preventDefault();
                    selectOption(opt);
                });
                btn.addEventListener('mouseenter', function () {
                    activeIndex = index;
                    Array.from(listEl.children).forEach(function (child, i) {
                        child.classList.toggle('photo-tag-suggest-item--active', i === activeIndex);
                    });
                });
                listEl.appendChild(btn);
            });
            wrap.appendChild(listEl);
            input.setAttribute('aria-expanded', 'true');
        }

        input.addEventListener('focus', function () {
            renderList(input.value);
        });

        input.addEventListener('input', function () {
            renderList(input.value);
        });

        input.addEventListener('keydown', function (ev) {
            if (!currentMatches.length) return;
            if (ev.key === 'ArrowDown') {
                ev.preventDefault();
                activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1);
            } else if (ev.key === 'ArrowUp') {
                ev.preventDefault();
                activeIndex = Math.max(activeIndex - 1, 0);
            } else if (ev.key === 'Enter' && activeIndex >= 0) {
                ev.preventDefault();
                selectOption(currentMatches[activeIndex]);
                return;
            } else if (ev.key === 'Escape') {
                removeList(wrap);
                input.setAttribute('aria-expanded', 'false');
                syncInputFromSelect(selectEl, input);
                return;
            } else {
                return;
            }
            const listEl = wrap.querySelector('.searchable-select-list');
            if (!listEl) return;
            Array.from(listEl.children).forEach(function (child, i) {
                child.classList.toggle('photo-tag-suggest-item--active', i === activeIndex);
            });
            const activeEl = listEl.children[activeIndex];
            if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });
        });

        input.addEventListener('blur', function () {
            setTimeout(function () {
                removeList(wrap);
                input.setAttribute('aria-expanded', 'false');
                syncInputFromSelect(selectEl, input);
            }, 120);
        });

        selectEl.addEventListener('change', function () {
            syncInputFromSelect(selectEl, input);
        });
    }

    function bindSearchableSelect(selectEl, options) {
        if (!selectEl) return;
        teardownSearchableSelect(selectEl);
        selectEl.dataset.searchableSelectBound = '1';
        if (isMobileSearchableSelectViewport()) {
            bindMobileSearchableSelect(selectEl, options);
        } else {
            bindDesktopSearchableSelect(selectEl, options);
        }
    }

    function setSearchableSelectValue(selectEl, value) {
        if (!selectEl) return;
        selectEl.value = value != null ? String(value) : '';
        const wrap = selectEl.closest('.searchable-select-wrap');
        if (!wrap) return;
        const trigger = wrap.querySelector('.searchable-select-trigger');
        const input = wrap.querySelector('.searchable-select-input');
        if (trigger) syncTriggerFromSelect(selectEl, trigger);
        else syncInputFromSelect(selectEl, input);
    }

    function syncSearchableSelectDisabled(selectEl, disabled) {
        if (!selectEl) return;
        selectEl.disabled = !!disabled;
        const wrap = selectEl.closest('.searchable-select-wrap');
        if (!wrap) return;
        const trigger = wrap.querySelector('.searchable-select-trigger');
        const input = wrap.querySelector('.searchable-select-input');
        if (trigger) trigger.disabled = !!disabled;
        if (input) input.disabled = !!disabled;
    }

    window.searchableSelectModule = {
        bindSearchableSelect,
        setSearchableSelectValue,
        syncSearchableSelectDisabled,
        teardownSearchableSelect,
        isMobileSearchableSelectViewport,
    };
})();
