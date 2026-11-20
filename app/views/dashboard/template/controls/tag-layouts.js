const ajax = require("../js/ajax.js");
const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

// The "Tag pages" control: one row per tag with its own layout. Every change
// posts the whole set as JSON (save/tag-layouts.js), so removing a row
// removes that tag's layout.
document.querySelectorAll("form[data-tag-layouts]").forEach(function (form) {
  const rows = form.querySelector(".tag-layouts__rows");
  const picker = form.querySelector("[data-add-tag]");
  const template = form.querySelector("template[data-row]");
  const field = form.querySelector('input[name="tag_layouts_json"]');

  function save() {
    const layouts = {};
    rows.querySelectorAll(".tag-layouts__row").forEach(function (row) {
      layouts[row.dataset.slug] = row.querySelector("select").value;
    });
    field.value = JSON.stringify(layouts);

    const body = new URLSearchParams();
    body.append("tag_layouts_json", field.value);
    body.append("_csrf", form.querySelector('input[name="_csrf"]').value);
    fetch(withAjax(window.location.href), { method: "post", body }).then(
      handleAjaxSaveResponse
    );
  }

  function bind(row) {
    const name = row.querySelector(".tag-layouts__tag").textContent;
    const select = row.querySelector("select");
    const remove = row.querySelector(".tag-layouts__remove");
    select.setAttribute("aria-label", "Layout for " + name);
    remove.setAttribute("aria-label", "Use the default layout for " + name);
    select.addEventListener("change", save);
    remove.addEventListener("click", function () {
      // Offer the tag in the picker again
      const option = document.createElement("option");
      option.value = row.dataset.slug;
      option.textContent = name;
      picker.appendChild(option);
      row.remove();
      save();
    });
  }

  rows.querySelectorAll(".tag-layouts__row").forEach(bind);

  picker.addEventListener("change", function () {
    const option = picker.selectedOptions[0];
    if (!option || !option.value) return;

    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.slug = option.value;
    row.querySelector(".tag-layouts__tag").textContent = option.textContent;
    rows.appendChild(row);
    bind(row);

    option.remove();
    picker.value = "";
    save();
    row.querySelector("select").focus();
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
  });
});
