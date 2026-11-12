(() => {
  "use strict";

  const personalUrlFilters = ["devices", "cableDevice", "hiddenRows", "face", "vlan", "vlanKind"];

  function mount({get, config, capture, apply, canSwitch, requestMutation, toolbar, applyToolbarVisibility}) {
    if (!config) return {activeId: null};
    const group = get("saved-views");
    const select = get("saved-view-select");
    const manage = get("saved-view-manage");
    const status = get("saved-view-status");
    const dialog = get("saved-view-dialog");
    const form = get("saved-view-form");
    const name = get("saved-view-name");
    const update = get("saved-view-update");
    const existing = get("saved-view-existing");
    const defaultButton = get("saved-view-default");
    const deleteButton = get("saved-view-delete");
    const deleteConfirm = get("saved-view-delete-confirm");
    const keep = get("saved-view-delete-cancel");
    const remove = get("saved-view-delete-yes");
    const error = get("saved-view-error");
    let views = config.views ?? [];
    const current = () => views.find(view => view.id === activeId);
    const params = new URLSearchParams(location.search);
    const requested = params.get("view") ?? (personalUrlFilters.some(key => params.has(key)) ? "personal" : null);
    let activeId = requested === null ? views.find(view => view.isDefault)?.id ?? null
      : views.find(view => String(view.id) === requested)?.id ?? null;
    let personal = capture();
    let mutating = false;

    function feedback(message = "", failed = false) {
      status.textContent = message;
      status.hidden = !message;
      status.classList.toggle("text-danger", failed);
    }

    function dialogError(message = "") {
      error.textContent = message;
      error.hidden = !message;
    }

    function renderOptions() {
      select.replaceChildren(new Option("Personal view", "personal"));
      for (const view of views) {
        select.add(new Option(view.name + (view.isDefault ? " (rack default)" : ""), String(view.id)));
      }
      select.value = activeId === null ? "personal" : String(activeId);
      select.hidden = !views.length;
      group.hidden = select.hidden && manage.hidden;
    }

    function activate(view, applySettings = true) {
      if (activeId === null && view) personal = capture();
      activeId = view?.id ?? null;
      const url = new URL(location.href);
      url.searchParams.set("view", activeId === null ? "personal" : String(activeId));
      if (view) {
        for (const key of personalUrlFilters) url.searchParams.delete(key);
      }
      history.replaceState(history.state, "", url);
      renderOptions();
      if (applySettings) apply(view?.settings ?? personal);
    }

    async function mutate(body, onSuccess) {
      if (mutating || !canSwitch()) return;
      mutating = true;
      dialogError();
      const controls = Array.from(form.elements);
      for (const control of controls) control.disabled = true;
      try {
        const payload = await requestMutation(config.url, body);
        if (!Array.isArray(payload.views)) throw new Error("NetBox did not return the updated views.");
        views = payload.views;
        onSuccess(views.find(view => view.id === payload.viewId));
        dialog.close();
      } catch (failure) {
        dialogError(failure.message || "NetBox could not save the rack views.");
      } finally {
        mutating = false;
        for (const control of controls) control.disabled = false;
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

    manage.hidden = !config.canManage;
    manage.addEventListener("click", () => {
      if (!canSwitch()) return;
      const view = current();
      name.value = view?.name ?? "";
      update.hidden = existing.hidden = !view;
      defaultButton.textContent = view?.isDefault ? "Clear rack default" : "Set rack default";
      deleteConfirm.hidden = true;
      toolbar.openEditor();
      dialogError();
      dialog.showModal();
      name.select();
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      const view = current();
      const settings = capture({effectiveFace: true});
      settings.toolbar = toolbar.readEditor();
      const title = name.value.trim();
      const body = event.submitter?.value === "update" && view
        ? {action: "save", id: view.id, revision: view.revision, name: title, settings}
        : {action: "create", name: title, settings};
      void mutate(body, saved => {
        if (!saved) throw new Error("NetBox did not return the saved view.");
        activate(saved, false);
        applyToolbarVisibility(saved.settings.toolbar);
        feedback("Saved “" + saved.name + "”.");
      });
    });
    defaultButton.addEventListener("click", () => {
      const view = current();
      if (!view) return;
      void mutate({action: "save", id: view.id, revision: view.revision, isDefault: !view.isDefault}, saved => {
        renderOptions();
        feedback(saved?.isDefault ? "“" + saved.name + "” is the rack default." : "Rack default cleared.");
      });
    });
    deleteButton.addEventListener("click", () => {
      const view = current();
      if (!view) return;
      get("saved-view-delete-message").textContent = "Delete “" + view.name + "” for everyone?" +
        (view.isDefault ? " This also clears the rack default." : "");
      deleteConfirm.hidden = false;
      keep.focus();
    });
    keep.addEventListener("click", () => {
      deleteConfirm.hidden = true;
      deleteButton.focus();
    });
    remove.addEventListener("click", () => {
      const view = current();
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
    if (requested !== null && requested !== "personal" && activeId === null) {
      feedback("This saved view is unavailable. Showing your personal view.", true);
    }
    return {
      get activeId() { return activeId; },
      get initialSettings() { return current()?.settings; },
    };
  }

  globalThis.NbCableEditorSavedViews = {mount};
})();
