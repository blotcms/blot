const ajax = require("../js/ajax.js");
const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

// Text settings (load/text-inputs.js): saved half a second after typing
// stops, and straight away when the field loses focus or Enter is pressed.
document.querySelectorAll("form[data-text-input]").forEach(function (form) {
  const input = form.querySelector('input[type="text"]');
  let timer = null;
  let saved = input.value;

  function save() {
    clearTimeout(timer);
    if (input.value === saved) return;
    saved = input.value;

    const body = new URLSearchParams();
    body.append(input.name, input.value);
    body.append("_csrf", form.querySelector('input[name="_csrf"]').value);
    fetch(withAjax(window.location.href), { method: "post", body }).then(
      handleAjaxSaveResponse
    );
  }

  input.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  });
  input.addEventListener("blur", save);
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    save();
  });
});
