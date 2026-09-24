const ajax = require("./ajax.js");
const {
  presetMatches,
} = require("../../../../dashboard/site/template/preset-utils");

const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

function safeLocalKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key || "");
}

function parseMatch(button) {
  if (!button) return null;
  try {
    return JSON.parse(button.getAttribute("data-preset-match"));
  } catch (err) {
    return null;
  }
}

function currentLocals(group) {
  const locals = {};

  if (group === "colors") {
    document.querySelectorAll("form.color-picker input.value").forEach((input) => {
      const key = String(input.name || "").replace(/^locals\./, "");
      if (key) locals[key] = input.value;
    });
    return locals;
  }

  document.querySelectorAll("[data-font-picker-form]").forEach((form) => {
    const key = form.getAttribute("data-font-picker-key");
    if (!key) return;
    const value = {};
    const idInput = form.querySelector("[data-font-picker-value]");
    const size = form.querySelector('input[name="locals.' + key + '.font_size"]');
    const line = form.querySelector('input[name="locals.' + key + '.line_height"]');
    if (idInput) value.id = idInput.value;
    if (size && size.value !== "") value.font_size = size.value;
    if (line && line.value !== "") value.line_height = line.value;
    locals[key] = value;
  });

  return locals;
}

const CHECK_BADGE_HTML =
  '<span class="preset-check-badge" aria-hidden="true"><svg viewBox="0 0 16 16">' +
  '<path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path>' +
  "</svg></span>";

function setCheckBadge(button, show) {
  const existing = button.querySelector(".preset-check-badge");
  if (show) {
    if (!existing) button.insertAdjacentHTML("beforeend", CHECK_BADGE_HTML);
  } else if (existing) {
    existing.remove();
  }
}

function setPressed(button, pressed) {
  button.classList.toggle("is-selected", pressed);
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
  // Only color tiles render a checkmark badge; font tiles don't have one.
  if (button.closest('[data-preset-grid="colors"]')) {
    setCheckBadge(button, pressed);
  }
}

function applyMatchToControls(group, match) {
  if (!match) return;

  if (group === "colors") {
    Object.keys(match).forEach((key) => {
      if (!safeLocalKey(key)) return;
      const input = document.querySelector(
        'form.color-picker input[name="locals.' + key + '"]'
      );
      if (!input) return;
      input.value = match[key];
      const previous = input.form && input.form.querySelector(".previous");
      if (previous) previous.style.background = match[key];
      if (input.form) {
        input.form.dispatchEvent(
          new CustomEvent("template-preset-color", {
            detail: { value: match[key] },
          })
        );
      }
    });
    return;
  }

  Object.keys(match).forEach((key) => {
    const patch = match[key] || {};
    const form = document.querySelector(
      '[data-font-picker-form][data-font-picker-key="' + key + '"]'
    );
    if (!form || !safeLocalKey(key)) return;

    if (patch.id != null && /^[A-Za-z0-9_-]+$/.test(String(patch.id))) {
      const idInput = form.querySelector("[data-font-picker-value]");
      if (idInput) idInput.value = patch.id;
      const option = document.querySelector(
        '[data-font-option-id="' + patch.id + '"]'
      );
      const label = form.querySelector("[data-font-picker-label]");
      if (label && option) label.innerHTML = option.innerHTML;
    }

    if (patch.font_size != null) {
      const size = form.querySelector('input[name="locals.' + key + '.font_size"]');
      if (size) size.value = patch.font_size;
    }

    if (patch.line_height != null) {
      const line = form.querySelector('input[name="locals.' + key + '.line_height"]');
      if (line) line.value = patch.line_height;
    }
  });
}

function refreshGroup(group) {
  const root = document.querySelector('[data-preset-group="' + group + '"]');
  if (!root) return;

  const locals = currentLocals(group);
  let matched = false;

  Array.from(root.querySelectorAll("[data-preset-match]")).forEach((button) => {
    if (button.disabled || button.classList.contains("is-disabled")) {
      setPressed(button, false);
      return;
    }
    const values = parseMatch(button);
    const hit = !matched && values && presetMatches(values, locals);
    if (hit) matched = true;
    setPressed(button, !!hit);
  });

  const custom = root.querySelector("[data-preset-custom]");
  if (!custom) return;

  custom.hidden = matched;
  custom.classList.toggle("is-selected", !matched);
  if (matched) custom.removeAttribute("aria-current");
  else custom.setAttribute("aria-current", "true");
}

document.querySelectorAll("[data-preset-form]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = new URLSearchParams(new FormData(form));
    const submitted = form.querySelector("button[type=submit]");
    const group = form.getAttribute("data-preset-group");

    fetch(withAjax(form.action), { method: "post", body }).then((response) => {
      if (response.ok) {
        applyMatchToControls(group, parseMatch(submitted));
        refreshGroup(group);
      }
      return handleAjaxSaveResponse(response);
    });
  });
});

document.addEventListener("template-local-changed", (event) => {
  const group = event.detail && event.detail.group;
  if (group !== "colors" && group !== "fonts") return;
  refreshGroup(group);
});
