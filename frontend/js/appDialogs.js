// In-app alert / confirm / prompt using the same modal-overlay pattern as the rest of the app.

(function () {
    let chain = Promise.resolve();

    function runSerial(task) {
        const p = chain.then(() => task());
        chain = p.catch(function () {});
        return p;
    }

    function getEls() {
        return {
            overlay: document.getElementById('appDialogOverlay'),
            title: document.getElementById('appDialogTitle'),
            message: document.getElementById('appDialogMessage'),
            inputWrap: document.getElementById('appDialogInputWrap'),
            input: document.getElementById('appDialogInput'),
            textarea: document.getElementById('appDialogTextarea'),
            actions: document.getElementById('appDialogActions'),
            closeBtn: document.getElementById('appDialogCloseBtn')
        };
    }

    function hideDialog() {
        const { overlay } = getEls();
        if (overlay) {
            overlay.style.display = 'none';
            overlay.setAttribute('aria-hidden', 'true');
        }
        document.body.style.overflow = '';
    }

    const APP_DIALOG_BACK_ID = 'appDialog';

    function isAppDialogOpen() {
        const { overlay } = getEls();
        return !!(overlay && overlay.style.display !== 'none' && overlay.getAttribute('aria-hidden') !== 'true');
    }

    function registerAppDialogBack(onBack) {
        if (!window.uiBackStack) return;
        window.uiBackStack.register({
            id: APP_DIALOG_BACK_ID,
            isOpen: isAppDialogOpen,
            onBack: onBack,
        });
    }

    function unregisterAppDialogBack(opts) {
        opts = opts || {};
        if (window.uiBackStack && window.uiBackStack.isRegistered(APP_DIALOG_BACK_ID)) {
            window.uiBackStack.unregister(APP_DIALOG_BACK_ID, opts);
        }
    }

    function clearActions(actionsEl) {
        if (!actionsEl) return;
        const clone = actionsEl.cloneNode(false);
        actionsEl.parentNode.replaceChild(clone, actionsEl);
        return document.getElementById('appDialogActions');
    }

    function makeDialogButton(label, variant) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'button app-dialog-btn app-dialog-btn-' + (variant === 'secondary' ? 'secondary' : 'primary');
        btn.textContent = label;
        return btn;
    }

    /** Stops mobile/desktop password managers from treating generic prompts as login fields. */
    function applyNoCredentialAutofillAttrs(el, options) {
        if (!el) return;
        options = options || {};
        el.setAttribute('autocomplete', 'off');
        if (options.randomizeName !== false) {
            el.setAttribute('autocorrect', 'on');
            el.setAttribute('spellcheck', 'true');
            el.setAttribute('aria-autocomplete', 'none');
            el.setAttribute('name', 'app-prompt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11));
        }
        el.setAttribute('data-lpignore', 'true');
        el.setAttribute('data-1p-ignore', 'true');
        el.setAttribute('data-bwignore', 'true');
        el.setAttribute('data-form-type', 'other');
    }

    /**
     * Enable/disable password autofill for fields that stay in the DOM while modals are closed.
     * @param {HTMLInputElement|null} el
     * @param {boolean} active
     * @param {'current'|'new'} [mode]
     */
    function setPasswordFieldAutofillActive(el, active, mode) {
        if (!el) return;
        if (active) {
            el.disabled = false;
            el.removeAttribute('data-lpignore');
            el.removeAttribute('data-1p-ignore');
            el.removeAttribute('data-bwignore');
            el.removeAttribute('data-form-type');
            el.setAttribute('autocomplete', mode === 'new' ? 'new-password' : 'current-password');
            return;
        }
        el.disabled = true;
        applyNoCredentialAutofillAttrs(el, { randomizeName: false });
    }

    /** iOS/Safari often shows password QuickType on first focus; brief readonly avoids that. */
    function focusPromptField(field, multiline) {
        var coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
        if (!multiline && coarse) {
            field.setAttribute('readonly', 'readonly');
            field.focus();
            window.setTimeout(function () {
                field.removeAttribute('readonly');
                if (typeof field.select === 'function') {
                    field.select();
                }
            }, 0);
        } else {
            field.focus();
            if (!multiline && typeof field.select === 'function') {
                field.select();
            }
        }
    }

    /**
     * @param {string} message
     * @param {{ title?: string }} [options]
     * @returns {Promise<void>}
     */
    function appAlert(message, options) {
        options = options || {};
        const title = options.title != null ? options.title : 'Notice';
        return runSerial(function () {
            return new Promise(function (resolve) {
                const els = getEls();
                if (!els.overlay || !els.message || !els.actions) {
                    window.alert(message != null ? String(message) : '');
                    resolve();
                    return;
                }

                els.title.textContent = title;
                els.message.textContent = message != null ? String(message) : '';
                els.message.style.whiteSpace = 'pre-wrap';
                els.message.style.wordBreak = 'break-word';
                if (els.inputWrap) els.inputWrap.style.display = 'none';
                if (els.input) els.input.value = '';
                if (els.textarea) els.textarea.value = '';

                const actions = clearActions(els.actions);
                const ok = makeDialogButton('OK', 'primary');
                actions.appendChild(ok);

                function done(fromBack) {
                    document.removeEventListener('keydown', onKey);
                    if (els.closeBtn) els.closeBtn.onclick = null;
                    els.overlay.onclick = null;
                    ok.onclick = null;
                    hideDialog();
                    if (fromBack) unregisterAppDialogBack({ fromPopstate: true });
                    else unregisterAppDialogBack();
                    resolve();
                }

                function onKey(e) {
                    if (e.key === 'Enter' || e.key === 'Escape') {
                        e.preventDefault();
                        done(false);
                    }
                }

                document.addEventListener('keydown', onKey);
                ok.onclick = function () {
                    done(false);
                };
                if (els.closeBtn) els.closeBtn.onclick = function () {
                    done(false);
                };
                els.overlay.onclick = function () {
                    done(false);
                };

                els.overlay.style.display = 'flex';
                els.overlay.style.zIndex = '75000';
                els.overlay.setAttribute('aria-hidden', 'false');
                document.body.style.overflow = 'hidden';
                registerAppDialogBack(function () {
                    done(true);
                });
                ok.focus();
            });
        });
    }

    /**
     * @param {string} message
     * @param {{ title?: string, confirmText?: string, cancelText?: string }} [options]
     * @returns {Promise<boolean>}
     */
    function appConfirm(message, options) {
        options = options || {};
        const title = options.title != null ? options.title : 'Confirm';
        const confirmText = options.confirmText != null ? options.confirmText : 'OK';
        const cancelText = options.cancelText != null ? options.cancelText : 'Cancel';
        return runSerial(function () {
            return new Promise(function (resolve) {
                const els = getEls();
                if (!els.overlay || !els.message || !els.actions) {
                    resolve(window.confirm(message != null ? String(message) : ''));
                    return;
                }

                els.title.textContent = title;
                els.message.textContent = message != null ? String(message) : '';
                els.message.style.whiteSpace = 'pre-wrap';
                els.message.style.wordBreak = 'break-word';
                if (els.inputWrap) els.inputWrap.style.display = 'none';

                const actions = clearActions(els.actions);
                const cancel = makeDialogButton(cancelText, 'secondary');
                const ok = makeDialogButton(confirmText, 'primary');
                actions.appendChild(cancel);
                actions.appendChild(ok);

                function cleanup(fromBack) {
                    document.removeEventListener('keydown', onKey);
                    if (els.closeBtn) els.closeBtn.onclick = null;
                    els.overlay.onclick = null;
                    cancel.onclick = null;
                    ok.onclick = null;
                    hideDialog();
                    if (fromBack) unregisterAppDialogBack({ fromPopstate: true });
                    else unregisterAppDialogBack();
                }

                function onKey(e) {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        cleanup(false);
                        resolve(false);
                    }
                }

                document.addEventListener('keydown', onKey);
                cancel.onclick = function () {
                    cleanup(false);
                    resolve(false);
                };
                ok.onclick = function () {
                    cleanup(false);
                    resolve(true);
                };
                if (els.closeBtn) {
                    els.closeBtn.onclick = function () {
                        cleanup(false);
                        resolve(false);
                    };
                }
                els.overlay.onclick = null;

                els.overlay.style.display = 'flex';
                els.overlay.style.zIndex = '75000';
                els.overlay.setAttribute('aria-hidden', 'false');
                document.body.style.overflow = 'hidden';
                registerAppDialogBack(function () {
                    cleanup(true);
                    resolve(false);
                });
                ok.focus();
            });
        });
    }

    /**
     * @param {string} message
     * @param {{ title?: string, choices?: Array<{ id: string, label: string, variant?: 'primary'|'secondary' }>, cancelText?: string }} [options]
     * @returns {Promise<string|null>} chosen choice id, or null if cancelled
     */
    function appChoice(message, options) {
        options = options || {};
        const title = options.title != null ? options.title : 'Choose';
        const choices = Array.isArray(options.choices) ? options.choices : [];
        const cancelText = options.cancelText != null ? options.cancelText : 'Cancel';
        return runSerial(function () {
            return new Promise(function (resolve) {
                const els = getEls();
                if (!els.overlay || !els.message || !els.actions) {
                    resolve(null);
                    return;
                }

                els.title.textContent = title;
                els.message.textContent = message != null ? String(message) : '';
                els.message.style.whiteSpace = 'pre-wrap';
                els.message.style.wordBreak = 'break-word';
                if (els.inputWrap) els.inputWrap.style.display = 'none';

                const actions = clearActions(els.actions);
                const cancel = makeDialogButton(cancelText, 'secondary');
                actions.appendChild(cancel);

                const choiceButtons = choices.map(function (choice) {
                    const btn = makeDialogButton(
                        choice.label,
                        choice.variant === 'primary' ? 'primary' : 'secondary'
                    );
                    actions.appendChild(btn);
                    return btn;
                });

                function cleanup(fromBack) {
                    document.removeEventListener('keydown', onKey);
                    if (els.closeBtn) els.closeBtn.onclick = null;
                    els.overlay.onclick = null;
                    cancel.onclick = null;
                    choiceButtons.forEach(function (btn) {
                        btn.onclick = null;
                    });
                    hideDialog();
                    if (fromBack) unregisterAppDialogBack({ fromPopstate: true });
                    else unregisterAppDialogBack();
                }

                function onKey(e) {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        cleanup(false);
                        resolve(null);
                    }
                }

                document.addEventListener('keydown', onKey);
                cancel.onclick = function () {
                    cleanup(false);
                    resolve(null);
                };
                choiceButtons.forEach(function (btn, i) {
                    const choice = choices[i];
                    btn.onclick = function () {
                        cleanup(false);
                        resolve(choice && choice.id != null ? String(choice.id) : null);
                    };
                });
                if (els.closeBtn) {
                    els.closeBtn.onclick = function () {
                        cleanup(false);
                        resolve(null);
                    };
                }
                els.overlay.onclick = null;

                els.overlay.style.display = 'flex';
                els.overlay.style.zIndex = '75000';
                els.overlay.setAttribute('aria-hidden', 'false');
                document.body.style.overflow = 'hidden';
                registerAppDialogBack(function () {
                    cleanup(true);
                    resolve(null);
                });
                const primaryBtn = choiceButtons.find(function (_, i) {
                    return choices[i] && choices[i].variant === 'primary';
                });
                (primaryBtn || choiceButtons[choiceButtons.length - 1] || cancel).focus();
            });
        });
    }

    /**
     * @param {string} message
     * @param {string} [defaultValue]
     * @param {{ title?: string, confirmText?: string, cancelText?: string, multiline?: boolean }} [options]
     * @returns {Promise<string|null>} null if cancelled or empty when required
     */
    function appPrompt(message, defaultValue, options) {
        if (typeof defaultValue === 'object' && defaultValue !== null && options === undefined) {
            options = defaultValue;
            defaultValue = '';
        }
        options = options || {};
        const title = options.title != null ? options.title : 'Input';
        const confirmText = options.confirmText != null ? options.confirmText : 'OK';
        const cancelText = options.cancelText != null ? options.cancelText : 'Cancel';
        const multiline = !!options.multiline;
        defaultValue = defaultValue != null ? String(defaultValue) : '';

        return runSerial(function () {
            return new Promise(function (resolve) {
                const els = getEls();
                if (!els.overlay || !els.message || !els.actions || !els.inputWrap) {
                    resolve(window.prompt(message != null ? String(message) : '', defaultValue));
                    return;
                }

                els.title.textContent = title;
                els.message.textContent = message != null ? String(message) : '';
                els.message.style.whiteSpace = 'pre-wrap';
                els.message.style.wordBreak = 'break-word';
                els.inputWrap.style.display = 'block';

                if (multiline) {
                    els.input.style.display = 'none';
                    els.textarea.style.display = 'block';
                    applyNoCredentialAutofillAttrs(els.textarea);
                    els.textarea.value = defaultValue;
                } else {
                    els.textarea.style.display = 'none';
                    els.input.style.display = 'block';
                    applyNoCredentialAutofillAttrs(els.input);
                    els.input.value = defaultValue;
                }

                const actions = clearActions(els.actions);
                const cancel = makeDialogButton(cancelText, 'secondary');
                const ok = makeDialogButton(confirmText, 'primary');
                actions.appendChild(cancel);
                actions.appendChild(ok);

                const activeField = multiline ? els.textarea : els.input;

                function cleanup(fromBack) {
                    document.removeEventListener('keydown', onKey);
                    if (els.closeBtn) els.closeBtn.onclick = null;
                    els.overlay.onclick = null;
                    cancel.onclick = null;
                    ok.onclick = null;
                    hideDialog();
                    if (fromBack) unregisterAppDialogBack({ fromPopstate: true });
                    else unregisterAppDialogBack();
                }

                function onKey(e) {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        cleanup(false);
                        resolve(null);
                    } else if (e.key === 'Enter' && !multiline) {
                        e.preventDefault();
                        submitOk();
                    }
                }

                function submitOk() {
                    const raw = multiline ? els.textarea.value : els.input.value;
                    cleanup(false);
                    resolve(raw);
                }

                function submitCancel(fromBack) {
                    cleanup(fromBack);
                    resolve(null);
                }

                document.addEventListener('keydown', onKey);
                cancel.onclick = function () {
                    submitCancel(false);
                };
                ok.onclick = submitOk;
                if (els.closeBtn) els.closeBtn.onclick = function () {
                    submitCancel(false);
                };
                els.overlay.onclick = null;

                els.overlay.style.display = 'flex';
                els.overlay.style.zIndex = '75000';
                els.overlay.setAttribute('aria-hidden', 'false');
                document.body.style.overflow = 'hidden';
                registerAppDialogBack(function () {
                    submitCancel(true);
                });
                focusPromptField(activeField, multiline);
            });
        });
    }

    /**
     * Password confirmation dialog (returns trimmed password or null if cancelled).
     * @param {string} message
     * @param {{ title?: string, confirmText?: string, cancelText?: string }} [options]
     * @returns {Promise<string|null>}
     */
    function appPasswordPrompt(message, options) {
        options = options || {};
        const title = options.title != null ? options.title : 'Confirm password';
        const confirmText = options.confirmText != null ? options.confirmText : 'Confirm';
        const cancelText = options.cancelText != null ? options.cancelText : 'Cancel';

        return runSerial(function () {
            return new Promise(function (resolve) {
                const els = getEls();
                if (!els.overlay || !els.message || !els.actions || !els.inputWrap) {
                    const raw = window.prompt(message != null ? String(message) : '', '');
                    resolve(raw == null ? null : String(raw).trim() || null);
                    return;
                }

                els.title.textContent = title;
                els.message.textContent = message != null ? String(message) : '';
                els.message.style.whiteSpace = 'pre-wrap';
                els.message.style.wordBreak = 'break-word';
                els.inputWrap.style.display = 'block';
                els.textarea.style.display = 'none';
                els.input.style.display = 'block';
                els.input.type = 'password';
                els.input.value = '';
                els.input.setAttribute('autocomplete', 'current-password');
                els.input.setAttribute('name', 'app-password-' + Date.now());

                const actions = clearActions(els.actions);
                const cancel = makeDialogButton(cancelText, 'secondary');
                const ok = makeDialogButton(confirmText, 'primary');
                actions.appendChild(cancel);
                actions.appendChild(ok);

                function cleanup(fromBack) {
                    document.removeEventListener('keydown', onKey);
                    if (els.closeBtn) els.closeBtn.onclick = null;
                    els.overlay.onclick = null;
                    cancel.onclick = null;
                    ok.onclick = null;
                    els.input.type = 'search';
                    applyNoCredentialAutofillAttrs(els.input);
                    hideDialog();
                    if (fromBack) unregisterAppDialogBack({ fromPopstate: true });
                    else unregisterAppDialogBack();
                }

                function onKey(e) {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        cleanup(false);
                        resolve(null);
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        submitOk();
                    }
                }

                function submitOk() {
                    const raw = els.input.value != null ? String(els.input.value).trim() : '';
                    cleanup(false);
                    resolve(raw || null);
                }

                function submitCancel(fromBack) {
                    cleanup(fromBack);
                    resolve(null);
                }

                document.addEventListener('keydown', onKey);
                cancel.onclick = function () {
                    submitCancel(false);
                };
                ok.onclick = submitOk;
                if (els.closeBtn) els.closeBtn.onclick = function () {
                    submitCancel(false);
                };
                els.overlay.onclick = null;

                els.overlay.style.display = 'flex';
                els.overlay.style.zIndex = '75000';
                els.overlay.setAttribute('aria-hidden', 'false');
                document.body.style.overflow = 'hidden';
                registerAppDialogBack(function () {
                    submitCancel(true);
                });
                els.input.focus();
            });
        });
    }

    function escapeAppInfoAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
    }

    /** Compact (i) control; click opens appAlert with title + message. */
    function buildAppInfoButtonHtml(title, message) {
        const t = String(title || 'Help');
        const m = String(message || '');
        return (
            '<button type="button" class="app-info-btn create-ticket-wizard-info-btn" data-app-info-btn' +
            ' data-app-info-title="' +
            escapeAppInfoAttr(t) +
            '"' +
            ' data-app-info-message="' +
            escapeAppInfoAttr(m) +
            '"' +
            ' aria-label="' +
            escapeAppInfoAttr(t + ' help') +
            '"' +
            ' title="' +
            escapeAppInfoAttr(t) +
            '"><span aria-hidden="true">i</span></button>'
        );
    }

    function bindAppInfoButtons() {
        if (document.documentElement.dataset.appInfoBound === '1') return;
        document.documentElement.dataset.appInfoBound = '1';
        document.addEventListener('click', function (ev) {
            const btn = ev.target.closest('[data-app-info-btn]');
            if (!btn) return;
            ev.preventDefault();
            ev.stopPropagation();
            const title = btn.getAttribute('data-app-info-title') || 'Help';
            const message = btn.getAttribute('data-app-info-message') || '';
            if (!message) return;
            void appAlert(message, { title: title });
        });
    }

    bindAppInfoButtons();

    window.appAlert = appAlert;
    window.appConfirm = appConfirm;
    window.appChoice = appChoice;
    window.appPrompt = appPrompt;
    window.appPasswordPrompt = appPasswordPrompt;
    window.buildAppInfoButtonHtml = buildAppInfoButtonHtml;
    window.applyNoCredentialAutofillAttrs = applyNoCredentialAutofillAttrs;
    window.setPasswordFieldAutofillActive = setPasswordFieldAutofillActive;
})();
