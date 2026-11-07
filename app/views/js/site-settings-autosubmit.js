var announce = require("./announce.js");
var checkboxes = document.querySelectorAll(".plugin input[type=checkbox]");

// Shown above the form when a save fails, and read out by screen readers
function showError(form, text) {
  var box = document.querySelector("[data-autosave-error]");

  if (!box) {
    box = document.createElement("div");
    box.className = "flash";
    box.setAttribute("role", "alert");
    box.setAttribute("data-autosave-error", "");
    box.innerHTML = '<p class="error flash__body"><span></span></p>';
    form.parentNode.insertBefore(box, form);
  }

  // Cleared first, so the same error a second time is read again
  var span = box.querySelector("span");
  span.textContent = "";
  setTimeout(function () {
    span.textContent = text;
  }, 50);
}

// The sync status at the top of the page shows the save as it goes
// (js/global-sync.js): "saving", then "saved" or "error"
function report(state) {
  document.dispatchEvent(
    new CustomEvent("blot:settings-save", { detail: { state: state } })
  );
}

// onFail runs when the save didn't go through, so the control can be put back
function submitForm(form, onFail) {
  if (!form) {
    return;
  }

  report("saving");

  var xhr = new XMLHttpRequest();
  xhr.open("POST", form.action);

  xhr.onload = function () {
    // A save redirects back to the settings page; an error page, or the log-in
    // page after an expired session, means nothing was saved
    if (xhr.status >= 400 || /\/log-in/.test(xhr.responseURL || "")) {
      fail();
      return;
    }

    var box = document.querySelector("[data-autosave-error]");
    if (box) box.parentNode.removeChild(box);
    announce("Saved");
    report("saved");

    // The save may have started a rebuild: js/global-sync.js shows it
    document.dispatchEvent(new CustomEvent("blot:sync-check"));
  };

  xhr.onerror = fail;
  xhr.send(new FormData(form));

  function fail() {
    report("error");
    if (onFail) onFail();
    showError(
      form,
      "Your change was not saved. Check your connection and reload the page to try again."
    );
  }
}

function markPlugin(el) {
  if (el.closest(".pluginOptions")) return;
  el.closest(".plugin").classList.toggle("checked", el.checked);
}

if (checkboxes.length) {
  checkboxes.forEach(function (checkbox) {
    checkbox.addEventListener("change", function () {
      var el = this;

      markPlugin(el);

      submitForm(this.closest("form"), function () {
        el.checked = !el.checked;
        markPlugin(el);
      });
    });
  });
}

// Forms marked data-autosave save each choice as it is made, like the
// switches above (the image metadata options). Arrowing through radios or a
// closed select fires a change per key, so only the choice made once the
// keys stop is saved.
document.querySelectorAll("form[data-autosave]").forEach(function (form) {
  var timer;
  form.addEventListener("change", function (event) {
    if (!event.target.matches("input[type=radio], select")) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      submitForm(form);
    }, 400);
  });
});

// For the other settings scripts which save as a choice is made
module.exports.submitForm = submitForm;
