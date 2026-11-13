(() => {
  "use strict";

  const personalUrlFilters = ["devices", "cableDevice", "hiddenRows", "face", "vlan", "vlanKind"];

  function mount({get, config, capture, apply, clearPersonal, preferSystemView, sharedCableView, canSwitch, requestMutation, toolbar,
    applyToolbarVisibility}) {
    const group = get("saved-views");
    const select = get("saved-view-select");
    const manage = get("saved-view-manage");
    const shortcuts = get("saved-view-shortcuts");
    const buttons = get("saved-view-buttons");
    const status = get("saved-view-status");
    const dialog = get("saved-view-dialog");
    const form = get("saved-view-form");
    const shared = get("saved-view-shared");
    const resetSystem = get("saved-view-reset-system");
    const resetRackDefault = get("saved-view-reset-rack-default");
    const name = get("saved-view-name");
    const update = get("saved-view-update");
    const existing = get("saved-view-existing");
    const defaultButton = get("saved-view-default");
    const deleteButton = get("saved-view-delete");
    const deleteConfirm = get("saved-view-delete-confirm");
    const keep = get("saved-view-delete-cancel");
    const remove = get("saved-view-delete-yes");
    const error = get("saved-view-error");
    const globalDesigner = get("saved-view-global");
    const canManage = config?.canManage === true;
    const share = sharedCableView && {
      id: "share-" + sharedCableView.token, name: "Shared cable view",
      isShare: true, settings: sharedCableView.settings,
    };
    const withShare = views => share ? [...views, share] : views;
    let views = withShare(config?.views ?? []);
    const rackDefault = () => views.find(view => view.isDefault);
    const current = () => views.find(view => view.id === activeId);
    const localView = () => views.find(view => view.id === activeId && typeof view.id === "number");
    const params = new URLSearchParams(location.search);
    const requested = params.get("view") ?? (personalUrlFilters.some(key => params.has(key)) ? "personal" : null);
    const initialDefault = preferSystemView ? null : rackDefault()?.id ?? null;
    let activeId = share && (params.has("cableView") || !params.has("view")) ? share.id
      : requested === null ? initialDefault : views.find(view => String(view.id) === requested)?.id ?? null;
    let personal = capture();
    let mutating = false;
    let renderedShortcutViews;
    const shortcutsById = new Map();

    function feedback(message = "", failed = false) {
      status.textContent = message;
      status.hidden = !message;
      status.classList.toggle("text-danger", failed);
    }

    function dialogError(message = "") {
      error.textContent = message;
      error.hidden = !message;
    }

    function renderShortcuts() {
      if (renderedShortcutViews !== views) {
        renderedShortcutViews = views;
        shortcutsById.clear();
        for (const view of views) {
          if (!view.isGlobal || !view.showInToolbar) continue;
          const button = buttons.ownerDocument.createElement("button");
          button.type = "button";
          button.className = "btn btn-outline-primary btn-sm";
          button.textContent = view.name;
          button.addEventListener("click", () => {
            if (mutating || activeId === view.id || !canSwitch()) return;
            activate(view);
            feedback();
          });
          shortcutsById.set(view.id, button);
        }
        buttons.replaceChildren(...shortcutsById.values());
      }
      for (const [id, button] of shortcutsById) {
        const active = activeId === id;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      }
      shortcuts.hidden = !shortcutsById.size;
    }

    function renderOptions() {
      select.replaceChildren(new Option("Personal view", "personal"));
      for (const view of views) {
        const qualifier = view.isDefault ? " (rack default)" : view.isGlobal ? " (global)" : "";
        select.add(new Option(view.name + qualifier, String(view.id)));
      }
      select.value = activeId === null ? "personal" : String(activeId);
      select.hidden = !views.length;
      group.hidden = select.hidden && manage.hidden;
      renderShortcuts();
    }

    function activate(view, {applySettings = true, reset = false, followDefault = false} = {}) {
      if (activeId === null && view && !reset) personal = capture();
      activeId = view?.id ?? null;
      const url = new URL(location.href);
      if (view?.isShare) url.searchParams.set("cableView", sharedCableView.token);
      else url.searchParams.delete("cableView");
      if (followDefault || view?.isShare) url.searchParams.delete("view");
      else url.searchParams.set("view", activeId === null ? "personal" : String(activeId));
      if (view || reset) {
        for (const key of personalUrlFilters) url.searchParams.delete(key);
      }
      const state = reset ? {...history.state, reRackDeviceImages: null, reRackEditor: null} : history.state;
      history.replaceState(state, "", url);
      renderOptions();
      if (applySettings) apply(view?.settings ?? personal);
    }

    function resetPersonal(followDefault = false) {
      if (mutating || !canSwitch()) return;
      const view = followDefault ? rackDefault() : undefined;
      personal = clearPersonal(followDefault);
      activate(view, {reset: true, followDefault});
      if (dialog.open) dialog.close();
      if (config) feedback(view ? "Personal settings cleared. Using the rack default." :
        "Personal settings cleared. Using system defaults.");
    }

    async function mutate(body, onSuccess) {
      if (!canManage || mutating || !canSwitch()) return;
      mutating = true;
      dialogError();
      const controls = Array.from(form.elements, control => [control, control.disabled]);
      for (const [control] of controls) control.disabled = true;
      try {
        const payload = await requestMutation(config.url, body);
        if (!Array.isArray(payload.views)) throw new Error("NetBox did not return the updated views.");
        views = withShare(payload.views);
        onSuccess(views.find(view => view.id === payload.viewId));
        dialog.close();
      } catch (failure) {
        dialogError(failure.message || "NetBox could not save the rack views.");
      } finally {
        mutating = false;
        for (const [control, disabled] of controls) control.disabled = disabled;
      }
    }

    select.addEventListener("change", () => {
      if (!canSwitch()) {
        renderOptions();
        return;
      }
      activate(views.find(view => String(view.id) === select.value));
      feedback();
    });

    manage.hidden = !config;
    shared.hidden = shared.disabled = !canManage;
    if (globalDesigner) {
      globalDesigner.hidden = !config?.globalDesignerUrl;
      globalDesigner.addEventListener("click", () => {
        if (!config?.globalDesignerUrl || !canSwitch()) return;
        try {
          const url = new URL(config.globalDesignerUrl, location.href);
          if (url.origin !== location.origin) throw new Error("The global view designer URL is invalid.");
          const view = current();
          const settings = capture({effectiveFace: true});
          if (canManage) settings.toolbar = toolbar.readEditor();
          sessionStorage.setItem("nbcableeditor:global-view-draft", JSON.stringify({
            id: view?.isGlobal ? Number(view.id.slice("global-".length)) : null,
            name: name.value.trim(),
            rackId: config.rackId,
            settings,
          }));
          location.assign(url);
        } catch (failure) {
          dialogError(failure.message || "Could not open the global view designer.");
        }
      });
    }
    manage.addEventListener("click", () => {
      if (!canSwitch()) return;
      const view = current();
      resetRackDefault.hidden = !rackDefault();
      name.value = view?.name ?? "";
      update.hidden = existing.hidden = !localView();
      defaultButton.textContent = view?.isDefault ? "Clear rack default" : "Set rack default";
      deleteConfirm.hidden = true;
      if (canManage) toolbar.openEditor();
      dialogError();
      dialog.showModal();
      if (canManage) name.select();
      else resetSystem.focus();
    });
    resetSystem.addEventListener("click", () => resetPersonal());
    resetRackDefault.addEventListener("click", () => resetPersonal(true));
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!canManage) return;
      const view = localView();
      const settings = capture({effectiveFace: true});
      settings.toolbar = toolbar.readEditor();
      const title = name.value.trim();
      const body = event.submitter?.value === "update" && view
        ? {action: "save", id: view.id, revision: view.revision, name: title, settings}
        : {action: "create", name: title, settings};
      void mutate(body, saved => {
        if (!saved) throw new Error("NetBox did not return the saved view.");
        activate(saved, {applySettings: false});
        applyToolbarVisibility(saved.settings.toolbar);
        feedback("Saved “" + saved.name + "”.");
      });
    });
    defaultButton.addEventListener("click", () => {
      const view = localView();
      if (!view) return;
      void mutate({action: "save", id: view.id, revision: view.revision, isDefault: !view.isDefault}, saved => {
        renderOptions();
        feedback(saved?.isDefault ? "“" + saved.name + "” is the rack default." : "Rack-specific default cleared.");
      });
    });
    deleteButton.addEventListener("click", () => {
      const view = localView();
      if (!view) return;
      get("saved-view-delete-message").textContent = "Delete “" + view.name + "” for everyone?" +
        (view.isDefault ? " This also removes its rack-specific default." : "");
      deleteConfirm.hidden = false;
      keep.focus();
    });
    keep.addEventListener("click", () => {
      deleteConfirm.hidden = true;
      deleteButton.focus();
    });
    remove.addEventListener("click", () => {
      const view = localView();
      if (!view) return;
      void mutate({action: "delete", id: view.id, revision: view.revision}, () => {
        activate();
        feedback("Deleted “" + view.name + "”.");
      });
    });
    get("saved-view-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", event => {
      if (mutating) event.preventDefault();
    });

    renderOptions();
    if (config && requested !== null && requested !== "personal" && activeId === null) {
      feedback("This saved view is unavailable. Showing your personal view.", true);
    }
    return {
      get activeId() { return activeId; },
      get initialSettings() { return current()?.settings; },
      resetPersonal,
    };
  }

  globalThis.NbCableEditorSavedViews = {mount};
})();
