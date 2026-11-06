// Save and Cancel (.buttons[data-on-change]) show only while the fields near
// them differ from how the page loaded: those inside the closest
// [data-changes], else the whole form. Cancel ([data-cancel]) puts the fields
// back and hides the buttons without leaving the page. Without scripts both
// stay visible, and Cancel's link reloads the page.

var announce = require("./announce.js");

function fields(scope) {
  return Array.prototype.slice.call(
    scope.querySelectorAll("input[name], select[name], textarea[name]")
  );
}

function snapshot(scope) {
  return fields(scope)
    .filter(function (field) {
      if (field.disabled || field.name === "_csrf") return false;
      if (field.type === "checkbox" || field.type === "radio")
        return field.checked;
      return true;
    })
    .map(function (field) {
      return field.name + "=" + field.value;
    })
    .join("\n");
}

document
  .querySelectorAll(".buttons[data-on-change]")
  .forEach(function (buttons) {
    var form = buttons.closest("form");
    if (!form) return;
    var scope = buttons.closest("[data-changes]") || form;
    var initial = snapshot(scope);

    function update() {
      buttons.hidden = snapshot(scope) === initial;
    }

    buttons.hidden = true;
    scope.addEventListener("input", update);
    scope.addEventListener("change", update);

    var cancel = buttons.querySelector("[data-cancel]");
    if (!cancel) return;

    cancel.addEventListener("click", function (event) {
      event.preventDefault();
      fields(scope).forEach(function (field) {
        if (field.type === "checkbox" || field.type === "radio")
          field.checked = field.defaultChecked;
        else if (field.tagName === "SELECT")
          Array.prototype.forEach.call(field.options, function (option) {
            option.selected = option.defaultSelected;
          });
        else field.value = field.defaultValue;
      });
      // js/form-buttons.js marks a clicked link as working
      cancel.classList.remove("working", "disabled");
      buttons.hidden = true;
      var first = fields(scope).find(function (field) {
        return field.type !== "hidden";
      });
      if (first) first.focus();
      announce("Changes discarded");
    });
  });
