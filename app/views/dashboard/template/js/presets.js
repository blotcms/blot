const ajax = require("./ajax.js");

const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

function numericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeColor(value) {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(color);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = digits.split("").map((digit) => digit + digit).join("");
    }
    if (digits.length === 6) digits += "ff";
    return "#" + digits;
  }

  if (!window.CSS || !window.CSS.supports("color", color)) return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  context.fillStyle = color;
  const parsed = context.fillStyle.toLowerCase();
  const normalizedHex = /^#([0-9a-f]{6})$/.exec(parsed);
  if (normalizedHex) return "#" + normalizedHex[1] + "ff";
  const rgb = /^rgba?\((\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?\)$/.exec(parsed);
  if (!rgb) return parsed;
  const channels = [rgb[1], rgb[2], rgb[3]].map((channel) =>
    Number(channel).toString(16).padStart(2, "0")
  );
  const alpha = Math.round(Number(rgb[4] == null ? 1 : rgb[4]) * 255)
    .toString(16)
    .padStart(2, "0");
  return "#" + channels.join("") + alpha;
}

function scalarMatches(declared, current, prop) {
  if (prop === "id") return String(declared == null ? "" : declared) === String(current == null ? "" : current);
  if (prop === "font_size" || prop === "line_height") {
    const left = numericValue(declared);
    const right = numericValue(current);
    return left !== null && right !== null && left === right;
  }
  const leftColor = normalizeColor(declared);
  const rightColor = normalizeColor(current);
  if (leftColor && rightColor) return leftColor === rightColor;
  return String(declared == null ? "" : declared).trim().toLowerCase() ===
    String(current == null ? "" : current).trim().toLowerCase();
}

function valueMatches(declared, current) {
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return false;
    const props = Object.keys(declared).filter(
      (prop) => prop !== "__proto__" && prop !== "constructor" && prop !== "prototype"
    );
    return props.length > 0 && props.every((prop) => scalarMatches(declared[prop], current[prop], prop));
  }
  return scalarMatches(declared, current);
}

function presetMatches(values, locals) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return false;
  const keys = Object.keys(values).filter(
    (key) => key !== "__proto__" && key !== "constructor" && key !== "prototype"
  );
  return keys.length > 0 && keys.every((key) => valueMatches(values[key], locals && locals[key]));
}

const storageKey = (group) =>
  "blot-preset-edit:" + window.location.pathname + ":" + group;

function safeKey(key) {
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

function setPressed(button, pressed) {
  button.classList.toggle("is-selected", pressed);
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
}

function stackFor(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id || "")) return "";
  const option = document.querySelector('[data-font-option-id="' + id + '"]');
  return option ? option.getAttribute("data-font-stack") || "" : "";
}

function updateCustomSwatches(custom, locals) {
  custom.querySelectorAll("[data-preset-swatch]").forEach((swatch) => {
    const key = swatch.getAttribute("data-preset-swatch");
    const color = locals[key];
    const inner = swatch.querySelector("span");
    if (color && inner) inner.style.background = color;
  });
}

function updateCustomFonts(custom, locals) {
  custom.querySelectorAll("[data-preset-font-key]").forEach((sample) => {
    const key = sample.getAttribute("data-preset-font-key");
    const id = locals[key] && locals[key].id;
    const stack = stackFor(id);
    if (stack) sample.style.fontFamily = stack;
  });
}

function applyMatchToControls(group, match) {
  if (!match) return;

  if (group === "colors") {
    Object.keys(match).forEach((key) => {
      if (!safeKey(key)) return;
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
    if (!form || !safeKey(key)) return;

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

  if (group === "colors") updateCustomSwatches(custom, locals);
  if (group === "fonts") updateCustomFonts(custom, locals);
}

function setOpen(group, open) {
  const root = document.querySelector('[data-preset-group="' + group + '"]');
  if (!root) return;
  const button = root.querySelector("[data-preset-edit]");
  const controls = root.querySelector("[data-preset-controls]");
  if (!button || !controls) return;

  controls.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");

  try {
    sessionStorage.setItem(storageKey(group), open ? "1" : "0");
  } catch (err) {}
}

function restoreOpen() {
  ["colors", "fonts"].forEach((group) => {
    try {
      if (sessionStorage.getItem(storageKey(group)) === "1") setOpen(group, true);
    } catch (err) {}
  });
}

document.querySelectorAll("[data-preset-edit]").forEach((button) => {
  button.addEventListener("click", () => {
    const group = button.getAttribute("data-preset-edit");
    const expanded = button.getAttribute("aria-expanded") === "true";
    setOpen(group, !expanded);
  });
});

document.querySelectorAll("[data-preset-form]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = new URLSearchParams(new FormData(form));
    const submitted = form.querySelector("button[type=submit]");
    const typeInput = form.querySelector('input[name="preset.type"]');
    const group = typeInput && typeInput.value;

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
  setOpen(group, true);
  refreshGroup(group);
});

restoreOpen();
