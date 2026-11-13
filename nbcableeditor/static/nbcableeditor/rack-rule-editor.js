(() => {
  "use strict";

  let nextId = 0;
  const TITLES = {interface: "Interface Rules", connection: "Connection Rules", device: "Device Rules"};
  const SUBJECTS = {interface: "interfaces", connection: "connections", device: "devices"};

  function element(tag, className = "", text = "") {
    const item = document.createElement(tag);
    item.className = className;
    item.textContent = text;
    return item;
  }

  function button(text, action, className = "btn-outline-secondary") {
    const control = element("button", "btn btn-sm " + className, text);
    control.type = "button";
    control.addEventListener("click", action);
    return control;
  }

  function label(text, control) {
    const field = element("div", "re-rule-field");
    const caption = element("label", "form-label mb-0", text);
    control.id = "re-rule-field-" + ++nextId;
    caption.htmlFor = control.id;
    field.append(caption, control);
    return field;
  }

  function checkbox(text, checked, change) {
    const field = element("label", "form-check mb-0");
    const control = element("input", "form-check-input");
    control.type = "checkbox";
    control.checked = checked;
    control.addEventListener("change", () => change(control.checked));
    field.append(control, element("span", "form-check-label", text));
    return field;
  }

  function conditionCount(tree) {
    return tree?.kind === "group" ? tree.children.reduce((sum, child) => sum + conditionCount(child), 0) : 1;
  }

  function booleanChoices(key) {
    if (["visible", "interfaces", "cables", "front", "rear"].includes(key)) return [[true, "Show"], [false, "Hide"]];
    if (["edit", "virtualPipe"].includes(key)) return [[true, "Allow"], [false, "Prevent"]];
    return [[true, "Enable"], [false, "Disable"]];
  }

  function createDialog(options) {
    const {kind, dialog, getRules, onApply, onPreview, onPreviewEnd} = options;
    const rulesApi = globalThis.NbCableEditorRules;
    const filters = globalThis.NbCableEditorConnectionFilter;
    const title = TITLES[kind];
    const definitions = rulesApi.actionDefinitions[kind];
    if (!title || !definitions) throw new Error("Choose a valid rule type.");
    const form = element("form", "re-rack-dialog-body re-rule-editor");
    form.noValidate = true;
    const heading = element("h2", "re-rack-dialog-title", title);
    heading.id = "re-rule-editor-title-" + ++nextId;
    const help = element("p", "re-rack-dialog-summary",
      "Rules run from top to bottom. Later matching actions override earlier actions. A matching halt stops the remaining rules. Empty conditions match all " + SUBJECTS[kind] + ".");
    const list = element("div", "re-rule-list");
    const empty = element("p", "text-secondary mb-0", "No rules. Existing display and editing settings apply.");
    const add = button("Add rule", addRule);
    add.dataset.ruleAdd = "";
    const error = element("p", "alert alert-danger mb-0");
    error.hidden = true;
    error.tabIndex = -1;
    error.setAttribute("role", "alert");
    const footer = element("div", "re-rack-dialog-actions");
    const cancel = button("Cancel", close);
    const preview = button("Preview in rack", previewRules);
    const apply = element("button", "btn btn-sm btn-primary", "Apply rules");
    apply.type = "submit";
    footer.append(cancel);
    if (onPreview) footer.append(preview);
    footer.append(apply);
    form.append(heading, help, list, empty, add, error, footer);
    dialog.append(form);
    dialog.classList.add("re-rule-dialog");
    dialog.setAttribute("aria-labelledby", heading.id);

    const conditionDialog = element("dialog", "re-rack-dialog re-connection-filter-dialog");
    conditionDialog.id = "re-rule-condition-dialog-" + ++nextId;
    dialog.parentElement.append(conditionDialog);
    let conditionEditor;
    let editingRule;
    let draft = [];
    let previewing = false;
    let destroyed = false;
    const lifecycle = new AbortController();

    function showError(message = "") {
      error.textContent = message;
      error.hidden = !message;
      if (message) error.focus();
    }

    function setAction(rule, key, value) {
      if (value === undefined) delete rule.actions[key];
      else rule.actions[key] = value;
    }

    function actionField(rule, definition) {
      const {key, type} = definition;
      const value = rule.actions[key];
      let control;
      if (type === "boolean" || type === "choice") {
        control = element("select", "form-select form-select-sm no-ts");
        control.add(new Option("Unchanged", ""));
        const choices = type === "boolean" ? booleanChoices(key) : definition.choices;
        for (const [entry, text] of choices) control.add(new Option(text, String(entry)));
        control.value = value === undefined ? "" : String(value);
        control.addEventListener("change", () => setAction(rule, key,
          control.value === "" ? undefined : type === "boolean" ? control.value === "true" : control.value));
      } else if (type === "number") {
        control = element("input", "form-control form-control-sm");
        control.type = "number";
        control.min = String(definition.min);
        control.max = String(definition.max);
        control.step = String(definition.step);
        control.placeholder = "Unchanged";
        control.value = value ?? "";
        control.addEventListener("input", () => setAction(rule, key,
          control.validity.badInput ? NaN : control.value === "" ? undefined : control.valueAsNumber));
      } else {
        control = element("input", "form-control form-control-sm");
        control.type = "text";
        control.maxLength = 7;
        control.placeholder = "Unchanged";
        control.value = value ?? "";
        control.addEventListener("input", () => setAction(rule, key, control.value.trim() || undefined));
      }
      control.dataset.ruleAction = key;
      const field = label(definition.label, control);
      if (type === "color") {
        const picker = element("input", "form-control form-control-color");
        picker.type = "color";
        picker.value = /^#[0-9a-f]{6}$/i.test(value) ? value : "#3388cc";
        picker.setAttribute("aria-label", "Choose " + definition.label.toLowerCase());
        picker.addEventListener("input", () => {
          control.value = picker.value;
          setAction(rule, key, picker.value);
        });
        control.addEventListener("input", () => {
          if (/^#[0-9a-f]{6}$/i.test(control.value)) picker.value = control.value;
        });
        const row = element("div", "re-rule-color");
        control.replaceWith(row);
        row.append(control, picker);
      }
      return field;
    }

    function renderRule(rule, index) {
      const card = element("section", "re-rule-card");
      card.dataset.ruleIndex = String(index);
      const header = element("div", "re-rule-header");
      const name = element("input", "form-control form-control-sm");
      name.type = "text";
      name.maxLength = 200;
      name.value = rule.name;
      name.placeholder = "Rule name";
      name.setAttribute("aria-label", "Rule name");
      name.dataset.ruleName = "";
      name.addEventListener("input", () => { rule.name = name.value; });
      const enabled = checkbox("Enabled", rule.enabled, checked => {
        rule.enabled = checked;
        card.classList.toggle("re-rule-disabled", !checked);
      });
      const up = button("↑", () => moveRule(index, -1));
      up.setAttribute("aria-label", "Move rule up");
      up.title = "Move rule up";
      up.disabled = index === 0;
      const down = button("↓", () => moveRule(index, 1));
      down.setAttribute("aria-label", "Move rule down");
      down.title = "Move rule down";
      down.disabled = index === draft.length - 1;
      const remove = button("Remove", () => {
        draft.splice(index, 1);
        render();
        (list.children[Math.min(index, draft.length - 1)]?.querySelector("[data-rule-name]") ?? add).focus();
      });
      header.append(name, enabled, up, down, remove);
      const conditions = element("div", "re-rule-conditions");
      const count = conditionCount(rule.condition);
      const summary = element("span", "text-secondary small",
        count ? count + (count === 1 ? " condition" : " conditions") : "All " + SUBJECTS[kind]);
      const editConditions = button("Edit conditions", () => editRuleConditions(rule));
      conditions.append(editConditions, summary,
        checkbox("Halt after this rule", rule.halt, checked => { rule.halt = checked; }));
      const actions = element("details", "re-rule-actions");
      actions.open = true;
      actions.append(element("summary", "form-label mb-0", "Actions"));
      const fields = element("div", "re-rule-action-fields");
      for (const definition of definitions) fields.append(actionField(rule, definition));
      actions.append(fields);
      card.classList.toggle("re-rule-disabled", !rule.enabled);
      card.append(header, conditions, actions);
      return card;
    }

    function render() {
      list.replaceChildren(...draft.map(renderRule));
      empty.hidden = draft.length > 0;
      add.disabled = draft.length >= 100;
      showError();
    }

    function addRule() {
      if (draft.length >= 100) return;
      draft.push({name: "", enabled: true, condition: filters.empty(), actions: {}, halt: false});
      render();
      list.lastElementChild.querySelector("[data-rule-name]").focus();
    }

    function moveRule(index, offset) {
      const target = index + offset;
      if (target < 0 || target >= draft.length) return;
      const [rule] = draft.splice(index, 1);
      draft.splice(target, 0, rule);
      render();
      list.children[target].querySelector("[data-rule-name]").focus();
    }

    function showAfterConditions() {
      editingRule = null;
      render();
      if (!destroyed && !dialog.open) dialog.showModal();
    }

    function editRuleConditions(rule) {
      editingRule = rule;
      dialog.close();
      if (!conditionEditor) {
        const create = kind === "connection" ? filters.createDialog : filters.createPortDialog;
        conditionEditor = create({
          ...options,
          dialog: conditionDialog,
          conditionOnly: true,
          title: title.replace("Rules", "rule conditions"),
          subjectLabel: SUBJECTS[kind],
          getFilter: () => editingRule.condition,
          onApply: tree => {
            editingRule.condition = structuredClone(tree);
            // The child closes after onApply returns.
            queueMicrotask(showAfterConditions);
          },
          onPreview: undefined,
          onPreviewEnd: undefined,
          onCancel: showAfterConditions,
        });
      }
      conditionEditor.open();
    }

    function validate() {
      try {
        rulesApi.validate(kind, draft);
        return true;
      } catch (failure) {
        showError(failure.message);
        return false;
      }
    }

    function cancelPreview() {
      if (!previewing) return;
      previewing = false;
      onPreviewEnd?.();
    }

    function close() {
      cancelPreview();
      dialog.close();
    }

    function previewRules() {
      if (!validate()) return;
      previewing = true;
      dialog.close();
      onPreview?.(structuredClone(draft));
    }

    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!validate()) return;
      onApply(structuredClone(draft));
      close();
    });
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      close();
    }, {signal: lifecycle.signal});

    return {
      open() {
        cancelPreview();
        draft = rulesApi.normalize(kind, getRules());
        render();
        dialog.showModal();
      },
      resume() {
        if (!previewing) return;
        cancelPreview();
        dialog.showModal();
        preview.focus();
      },
      cancelPreview,
      destroy() {
        destroyed = true;
        cancelPreview();
        lifecycle.abort();
        conditionEditor?.destroy();
        conditionDialog.remove();
        if (dialog.open) dialog.close();
        form.remove();
        dialog.classList.remove("re-rule-dialog");
        dialog.removeAttribute("aria-labelledby");
      },
    };
  }

  globalThis.NbCableEditorRuleEditor = {createDialog};
})();
