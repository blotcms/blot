const ajax = require("../js/ajax.js");
const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

// The "Tag pages" control: a row for each of the blog's tags with a layout of
// its own. Every change posts the whole set as JSON (save/tag-layouts.js),
// with the template's layouts for tags the blog doesn't have, which aren't
// shown. Setting a row back to Default removes it.
document.querySelectorAll("form[data-tag-layouts]").forEach(function (form) {
  const rows = form.querySelector(".tag-layouts__rows");
  const add = form.querySelector(".tag-layouts__add");
  const picker = form.querySelector("[data-add-tag]");
  const template = form.querySelector("template[data-row]");
  const csrf = form.querySelector('input[name="_csrf"]').value;

  let hidden = {};
  try {
    hidden = JSON.parse(form.dataset.hidden || "{}");
  } catch (e) {
    hidden = {};
  }

  function save() {
    const layouts = Object.assign({}, hidden);
    rows.querySelectorAll(".tag-layouts__row").forEach(function (row) {
      const value = row.querySelector("select").value;
      if (value) layouts[row.dataset.slug] = value;
    });

    const body = new URLSearchParams();
    body.append("tag_layouts_json", JSON.stringify(layouts));
    body.append("_csrf", csrf);
    fetch(withAjax(window.location.href), { method: "post", body }).then(
      handleAjaxSaveResponse
    );
  }

  function offer(slug, name) {
    // Put the tag back in the picker, in order
    const option = document.createElement("option");
    option.value = slug;
    option.textContent = name;
    const after = Array.from(picker.options).find(
      (o) => o.value && o.textContent.localeCompare(name) > 0
    );
    picker.insertBefore(option, after || null);
    add.hidden = false;
  }

  function open(select) {
    select.focus();
    if (typeof select.showPicker === "function") {
      try {
        select.showPicker();
      } catch (e) {
        // Focus is enough where the picker can't be opened from script
      }
    }
  }

  function bind(row) {
    const name = row.querySelector(".tag-layouts__tag").textContent;
    const select = row.querySelector("select");
    select.classList.toggle("is-default", !select.value);

    select.addEventListener("change", function () {
      select.classList.toggle("is-default", !select.value);
      if (!select.value) {
        offer(row.dataset.slug, name);
        row.remove();
      }
      save();
    });

    row.addEventListener("click", function (event) {
      if (event.target !== select) open(select);
    });
  }

  rows.querySelectorAll(".tag-layouts__row").forEach(bind);

  picker.addEventListener("change", function () {
    const option = picker.selectedOptions[0];
    if (!option || !option.value) return;

    const row = template.content.firstElementChild.cloneNode(true);
    const id = "tag-layout." + option.value;
    row.dataset.slug = option.value;
    row.querySelector(".tag-layouts__tag").textContent = option.textContent;
    row.querySelector(".tag-layouts__tag").setAttribute("for", id);
    row.querySelector("select").id = id;
    rows.appendChild(row);
    bind(row);

    option.remove();
    picker.value = "";
    add.hidden = picker.options.length < 2;
    // Nothing is saved until a layout is picked
    open(row.querySelector("select"));
  });

  // Keep "Default (Rows)" in step with the default layout above
  const fallback = form.parentNode.querySelector(
    'select[name="locals.tag_layout"]'
  );
  if (fallback) {
    fallback.addEventListener("change", function () {
      const label =
        "Default (" + fallback.selectedOptions[0].textContent.trim() + ")";
      form.querySelectorAll('option[value=""]').forEach(function (option) {
        if (option.parentNode !== picker) option.textContent = label;
      });
      template.content
        .querySelectorAll('option[value=""]')
        .forEach(function (option) {
          option.textContent = label;
        });
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
  });
});
