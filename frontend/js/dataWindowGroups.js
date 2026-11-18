// Data Window Groups - User-defined groups per tab (annotations, layers, photos, etc.)

const DATA_VIEWS = ['annotations', 'layers', 'photos', 'documents', 'aerialmaps', 'events'];

function getStorageKey() {
    if (typeof window.getUserStorageKey === 'function') {
        return window.getUserStorageKey('userProfile');
    }
    return window.authModule?.getCurrentUser()?.id
        ? `userProfile_user_${window.authModule.getCurrentUser().id}`
        : 'userProfile';
}

function loadAllGroups() {
    try {
        const key = getStorageKey();
        const profile = JSON.parse(localStorage.getItem(key) || '{}');
        const g = profile.dataWindowGroups || {};
        DATA_VIEWS.forEach(view => {
            if (!Array.isArray(g[view])) g[view] = [];
        });
        return g;
    } catch (e) {
        return DATA_VIEWS.reduce((acc, v) => ({ ...acc, [v]: [] }), {});
    }
}

function saveAllGroups(allGroups) {
    try {
        const key = getStorageKey();
        const profile = JSON.parse(localStorage.getItem(key) || '{}');
        profile.dataWindowGroups = allGroups;
        localStorage.setItem(key, JSON.stringify(profile));
        if (typeof window.schedulePersistUserUiPreferencesToServer === 'function') {
            window.schedulePersistUserUiPreferencesToServer();
        }
    } catch (e) {
        console.error('Failed to save data window groups', e);
    }
}

function getGroups(view) {
    if (!DATA_VIEWS.includes(view)) return [];
    const all = loadAllGroups();
    return Array.isArray(all[view]) ? all[view] : [];
}

function saveGroups(view, groups) {
    const all = loadAllGroups();
    all[view] = groups;
    saveAllGroups(all);
}

function createGroup(view, name, itemIds) {
    const groups = getGroups(view);
    const id = 'group_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    groups.push({ id, name: name || 'New Group', itemIds: itemIds || [], collapsed: false });
    saveGroups(view, groups);
    return id;
}

function deleteGroup(view, groupId) {
    saveGroups(view, getGroups(view).filter(g => g.id !== groupId));
}

function renameGroup(view, groupId, name) {
    const groups = getGroups(view).map(g =>
        g.id === groupId ? { ...g, name: name || g.name } : g
    );
    saveGroups(view, groups);
}

function addToGroup(view, groupId, itemIds) {
    const groups = getGroups(view).map(g => {
        if (g.id !== groupId) return g;
        const set = new Set([...g.itemIds, ...itemIds]);
        return { ...g, itemIds: Array.from(set) };
    });
    saveGroups(view, groups);
}

function removeFromGroup(view, groupId, itemIdsToRemove) {
    const set = new Set(itemIdsToRemove);
    const groups = getGroups(view).map(g => {
        if (g.id !== groupId) return g;
        return { ...g, itemIds: g.itemIds.filter(id => !set.has(id)) };
    });
    saveGroups(view, groups);
}

function toggleGroupCollapsed(view, groupId) {
    const groups = getGroups(view).map(g =>
        g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
    );
    saveGroups(view, groups);
}

function getItemIdsInGroups(view) {
    const groups = getGroups(view);
    const set = new Set();
    groups.forEach(g => (g.itemIds || []).forEach(id => set.add(id)));
    return set;
}

function getGroupByItemId(view, itemId) {
    return getGroups(view).find(g => (g.itemIds || []).includes(itemId)) || null;
}

function ungroupDataGroup(view, groupId) {
    deleteGroup(view, groupId);
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

async function renameDataGroup(view, groupId) {
    const groups = getGroups(view);
    const g = groups.find(x => x.id === groupId);
    if (!g) return;
    const name = await appPrompt('Group name:', g.name || 'New Group', { title: 'Rename group' });
    if (name != null && name.trim() !== '') {
        renameGroup(view, groupId, name.trim());
        if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    }
}

function toggleDataGroupCollapsed(view, groupId) {
    toggleGroupCollapsed(view, groupId);
    if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
        window.dataTableRendererModule.renderDataTable();
    }
}

function confirmDeleteDataGroup(view, groupId, message) {
    const msg = message || 'Delete this group? Layers will not be deleted.';
    appConfirm(msg, { title: 'Delete group' }).then(function (ok) {
        if (!ok) return;
        window.dataWindowGroupsModule.deleteGroup(view, groupId);
        if (window.dataTableRendererModule && window.dataTableRendererModule.renderDataTable) {
            window.dataTableRendererModule.renderDataTable();
        }
    });
}

window.dataWindowGroupsModule = {
    getGroups,
    saveGroups,
    createGroup,
    deleteGroup,
    renameGroup,
    addToGroup,
    removeFromGroup,
    toggleGroupCollapsed,
    getItemIdsInGroups,
    getGroupByItemId,
    ungroupDataGroup,
    renameDataGroup,
    toggleDataGroupCollapsed,
    DATA_VIEWS
};
window.ungroupDataGroup = ungroupDataGroup;
window.renameDataGroup = renameDataGroup;
window.toggleDataGroupCollapsed = toggleDataGroupCollapsed;
window.confirmDeleteDataGroup = confirmDeleteDataGroup;
