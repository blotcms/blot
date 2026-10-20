const CodeMirror = require("./codemirror/codemirror.js");
const initSidebarActionMenu = require("./sidebar-action-menu");

require("./codemirror/active-line.js");
require("./codemirror/match-brackets.js");
require("./codemirror/mode-css.js");
require("./codemirror/mode-simple.js");
require("./codemirror/mode-multiplex.js");
require("./codemirror/mode-handlebars.js");
require("./codemirror/mode-htmlmixed.js");
require("./codemirror/mode-javascript.js");
require("./codemirror/mode-xml.js");

function initializeSourceEditor() {
  if (typeof window === "undefined" || !window.document || !CodeMirror) return;

  var sourceElement = document.getElementById("source");
  if (!sourceElement) return;

  var saveButton = document.getElementById("save");
  var form = document.querySelector("form.save");
  if (!form || !saveButton) return;

  sourceElement.style.display = "none";

  var baseMode = sourceElement.getAttribute("data-mode") || "htmlmixed";

  var editor = CodeMirror.fromTextArea(sourceElement, {
    mode: { name: "handlebars", base: baseMode },
    lineNumbers: true,
    lineWrapping: true,
    smartIndent: false,
    styleActiveLine: true,
    matchBrackets: true,
    theme: "default",
    extraKeys: {
      "Cmd-S": doSave,
      "Ctrl-S": doSave,
    },
    indentUnit: 2, // tab = 2 spaces
    tabSize: 2, // render tabs as 2 spaces
    indentWithTabs: false, // insert spaces, not tab chars
  });

  editor.on("change", function () {
    setButtonState({
      text: "Save changes",
      value: "Save",
      disabled: false,
      working: false,
      disabledClass: false,
    });
  });

  function setButtonState(options) {
    const text = options.text;
    const value = options.value;
    const disabled = options.disabled;
    const working = options.working;
    const disabledClass = options.disabledClass;

    if (typeof text === "string") saveButton.textContent = text;
    if (typeof value === "string") saveButton.value = value;
    if (typeof disabled === "boolean") saveButton.disabled = disabled;

    saveButton.classList.toggle("working", !!working);
    saveButton.classList.toggle("disabled", !!disabledClass);
  }

  function showError(msg) {
    var el = document.querySelector(".error");
    if (!el) return;
    el.textContent = msg || "An error occurred";
    el.style.display = "block";
    el.style.opacity = "1";
  }

  function hideError() {
    var el = document.querySelector(".error");
    if (!el) return;
    el.style.display = "none";
  }

  function fadeOutSuccessAfter(ms) {
    var el = document.querySelector(".success");
    if (!el) return;
    // If your CSS has a transition on opacity, this will animate; otherwise it’s an instant hide.
    setTimeout(function () {
      el.style.opacity = "0";
      // Remove from flow after a short delay to allow any transition to run
      setTimeout(function () {
        el.style.display = "none";
        el.style.opacity = "";
      }, 300);
    }, ms);
  }

  function serializeForm(formEl) {
    return new URLSearchParams(new FormData(formEl)).toString();
  }

  async function handleSave(event) {
    if (event && typeof event.preventDefault === "function")
      event.preventDefault();

    if (saveButton.classList.contains("disabled")) return false;

    setButtonState({
      text: "Saving changes",
      value: "Saving",
      disabled: true,
      working: true,
      disabledClass: true,
    });

    // Mirror editor content into the hidden input
    var contentInput = form.querySelector('input[name="content"]');
    if (contentInput) contentInput.value = editor.getValue();

    hideError();

    try {
      const body = serializeForm(form);
      const res = await fetch(form.getAttribute("action"), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body,
        credentials: "same-origin",
      });

      // Support the fork header behavior
      const forked = res.headers.get("X-Template-Forked") === "1";
      if (forked) {
        window.location.reload();
        return false;
      }

      if (!res.ok) {
        const text = await res.text();
        setButtonState({
          text: "Save changes",
          value: "Save",
          disabled: false,
          working: false,
          disabledClass: false,
        });
        showError(text);
        return false;
      }

      setButtonState({
        text: "Saved",
        value: "Saved!",
        disabled: true,
        working: false,
        disabledClass: true,
      });

      hideError();
      fadeOutSuccessAfter(3000);
    } catch (err) {
      setButtonState({
        text: "Save changes",
        value: "Save",
        disabled: false,
        working: false,
        disabledClass: false,
      });
      showError(String(err && err.message ? err.message : err));
    }

    return false;
  }

  form.addEventListener("submit", handleSave);

  function doSave(cm) {
    handleSave();
  }
}

function initializeSourceSidebarMenu() {
  if (typeof window === "undefined" || !window.document) return;

  var list = document.getElementById("source-file-list");
  var menu = document.getElementById("source-file-action-menu");

  if (!list || !menu) return;

  var cleanBase = function (dataset) {
    var baseUrl = dataset.baseurl || "";
    if (baseUrl) baseUrl = baseUrl.replace(/\/+$/, "");
    return baseUrl;
  };

  initSidebarActionMenu({
    container: list,
    menuElement: menu,
    rowSelector: ".template-row",
    triggerSelector: ".row-action-menu__trigger",
    initialFocusKey: "edit",
    linkMap: {
      edit: function (dataset) {
        var baseUrl = cleanBase(dataset);
        return baseUrl ? baseUrl + "/edit" : null;
      },
      config: function (dataset) {
        var baseUrl = cleanBase(dataset);
        return baseUrl ? baseUrl + "/configure" : null;
      },
      rename: function (dataset) {
        var baseUrl = cleanBase(dataset);
        var disabled = dataset.disableRename === "true";
        return {
          href: baseUrl ? baseUrl + "/rename" : null,
          disabled: disabled || !baseUrl,
        };
      },
      "delete": function (dataset) {
        var baseUrl = cleanBase(dataset);
        var disabled = dataset.disableDelete === "true";
        return {
          href: baseUrl ? baseUrl + "/delete" : null,
          disabled: disabled || !baseUrl,
        };
      },
    },
  });
}

document.addEventListener("DOMContentLoaded", function () {
  initializeSourceEditor();
  initializeSourceSidebarMenu();
});
