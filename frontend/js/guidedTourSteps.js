/**
 * Step definitions for the first-run guided tour.
 * Hooks call window globals for hub / menu choreography.
 */
(function (global) {
    'use strict';

    const MQ = global.matchMedia('(max-width: 768px)');

    function isMobile() {
        return MQ.matches;
    }

    function isTicketHubOpen() {
        const el = document.getElementById('ticketHubWindow');
        return !!(el && el.classList.contains('show'));
    }

    function isDataHubOpen() {
        const el = document.getElementById('dataWindow');
        return !!(el && el.classList.contains('show'));
    }

    function openTicketHub() {
        if (typeof global.openTicketHubWindow === 'function') {
            void global.openTicketHubWindow();
        }
    }

    function closeTicketHub() {
        if (typeof global.closeTicketHubWindow === 'function') {
            global.closeTicketHubWindow();
        }
    }

    function openDataHub() {
        if (typeof global.openDataWindow === 'function') {
            global.openDataWindow();
        }
    }

    function closeDataHub() {
        if (typeof global.closeDataWindow === 'function') {
            global.closeDataWindow();
        }
    }

    function closeCircleMenus() {
        if (typeof global.closeAllCircleMenus === 'function') {
            global.closeAllCircleMenus();
        }
    }

    function openAccountMenu() {
        if (typeof global.openAccountMenu === 'function') {
            global.openAccountMenu();
        }
    }

    function openMobileLauncher() {
        if (typeof global.openMapTopLeftLauncher === 'function') {
            global.openMapTopLeftLauncher();
        }
    }

    function closeMobileLauncher() {
        if (typeof global.closeMapTopLeftLauncher === 'function') {
            global.closeMapTopLeftLauncher();
        }
    }

    function ensureMobileToolbarForTarget(selector) {
        if (!isMobile()) return;
        if (selector === '#orgMenuButton' || selector === '#ticketHubOpenButton' || selector === '#dataHubOpenButton') {
            openMobileLauncher();
        }
    }

    function resolveOrgTarget() {
        if (isMobile()) {
            openMobileLauncher();
            const bubble = document.querySelector('[data-launcher-action="org"]');
            return bubble || '#mapTopLeftMenuFab';
        }
        return '#orgMenuButton';
    }

    function resolveTicketHubTarget() {
        if (isMobile()) {
            closeMobileLauncher();
            return '#mapTopLeftActiveStatBubble';
        }
        return '#ticketHubOpenButton';
    }

    function resolveDataHubTarget() {
        if (isMobile()) {
            const filterBubble = document.getElementById('mapTopLeftDataHubFilterBubble');
            if (filterBubble && !filterBubble.hidden) {
                return '#mapTopLeftDataHubFilterBubble';
            }
            openMobileLauncher();
            const bubble = document.querySelector('[data-launcher-action="data-hub"]');
            return bubble || '#mapTopLeftMenuFab';
        }
        return '#dataHubOpenButton';
    }

    function resolveProfileTarget() {
        if (isMobile()) {
            openMobileLauncher();
            return '#mapTopLeftMenuFab';
        }
        return '#profileMenuButton';
    }

    function resolveStatusFilterTarget() {
        if (isMobile()) {
            return '#mapTopLeftActiveStatBubble';
        }
        const desktop = document.getElementById('mapStatusFilters');
        if (desktop && !desktop.hidden) {
            return '#mapStatusFilters';
        }
        return '#mapTopLeftActiveStatBubble';
    }

    function resolveLayerTarget() {
        if (isMobile()) {
            return '#mobileLayersButton';
        }
        return '#mapLayerControlToggle';
    }

    const STEPS = [
        {
            id: 'welcome',
            title: 'Welcome to Locus',
            body:
                global.CORE_PRODUCT === true
                    ? 'This is your map workspace for ticket management. This short tour shows where the main tools are.'
                    : 'This is your map workspace—tickets, photos, and field data all live here. This short tour shows where the main tools are.',
            placement: 'center',
            resolveTarget: function () {
                return null;
            },
            before: function () {
                closeCircleMenus();
                closeMobileLauncher();
            },
        },
        {
            id: 'ticket-hub-open',
            title: 'Ticket Hub',
            body: 'Search, filter, sync, assign work, and open ticket details from Ticket Hub.',
            placement: 'bottom',
            resolveTarget: resolveTicketHubTarget,
            before: function () {
                closeCircleMenus();
                closeMobileLauncher();
                if (!isMobile()) {
                    openTicketHub();
                }
            },
        },
        {
            id: 'data-hub',
            title: 'Data Hub',
            body: 'Manage annotations, data layers, photos, documents, aerial maps, and events in Data Hub.',
            placement: 'bottom',
            resolveTarget: resolveDataHubTarget,
            before: function () {
                closeCircleMenus();
                if (isTicketHubOpen()) {
                    closeTicketHub();
                }
                openDataHub();
                ensureMobileToolbarForTarget('#dataHubOpenButton');
            },
            after: function () {
                closeMobileLauncher();
                if (isDataHubOpen()) {
                    closeDataHub();
                }
            },
        },
        {
            id: 'map-tickets',
            title: 'Map tickets',
            body: 'Tap a ticket bubble or polygon to open its detail panel on the map—the same tabs you see in Ticket Hub.',
            placement: 'center',
            resolveTarget: function () {
                return '#map';
            },
            before: function () {
                closeMobileLauncher();
                closeCircleMenus();
                if (isDataHubOpen()) {
                    closeDataHub();
                }
                if (isTicketHubOpen()) {
                    closeTicketHub();
                }
            },
        },
        {
            id: 'status-filters',
            title: 'Status filters',
            body: 'Filter tickets by status. Counts match Ticket Hub stats. On mobile, press and hold the Tickets bubble for filters.',
            placement: 'bottom',
            resolveTarget: resolveStatusFilterTarget,
            before: function () {
                closeCircleMenus();
                closeMobileLauncher();
            },
        },
        {
            id: 'layers',
            title: 'Map layers',
            body:
                global.CORE_PRODUCT === true
                    ? 'Change the basemap and toggle the Tickets overlay.'
                    : 'Change basemap and toggle overlays such as Tickets, Photos, and Drone Maps.',
            placement: 'left',
            resolveTarget: resolveLayerTarget,
            before: function () {
                closeCircleMenus();
                closeMobileLauncher();
            },
        },
        {
            id: 'account-menu',
            title: 'Account menu',
            body: 'Open Settings, User Guide, Admin Panel (if allowed), or log out from the account menu.',
            placement: 'bottom',
            resolveTarget: resolveProfileTarget,
            before: function () {
                closeCircleMenus();
                if (isMobile()) {
                    openMobileLauncher();
                } else {
                    openAccountMenu();
                }
            },
            after: function () {
                closeCircleMenus();
                closeMobileLauncher();
            },
        },
        {
            id: 'finish',
            title: "You're all set",
            body: 'Open User Guide anytime from the account menu for deeper topics on tickets, projects, and map tools.',
            placement: 'center',
            resolveTarget: function () {
                return null;
            },
            before: function () {
                closeCircleMenus();
                closeMobileLauncher();
                if (isTicketHubOpen()) {
                    closeTicketHub();
                }
                if (isDataHubOpen()) {
                    closeDataHub();
                }
            },
            isFinish: true,
        },
    ];

    global.guidedTourStepDefinitions =
        global.CORE_PRODUCT === true ? STEPS.filter(function (step) {
            return step.id !== 'data-hub';
        }) : STEPS;
})(typeof window !== 'undefined' ? window : globalThis);
