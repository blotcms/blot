const ajax = require("../js/ajax.js");
const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

document.querySelectorAll("form.syntax-highlighter").forEach(function (form) {
  const csrfInput = form.querySelector('input[name="_csrf"]');
  const toggleInput = form.querySelector('input[name$="-toggle"]');
  const toggleLabel = toggleInput
    ? form.querySelector('label[for="' + toggleInput.id + '"]')
    : null;

  form.querySelectorAll("button").forEach(function (node) {
    const submitForm = (event) => {
      const body = new URLSearchParams();

      if (node.name) {
        body.append(node.name, node.value);
      }

      if (csrfInput) {
        body.append(csrfInput.name, csrfInput.value);
      }

      fetch(withAjax(window.location.href), { method: "post", body }).then(
        handleAjaxSaveResponse
      );

      if (toggleInput) {
        toggleInput.checked = false;
      }

      if (toggleLabel) {
        toggleLabel.innerHTML = node.innerHTML;
      }

      form.querySelectorAll("button").forEach(function (button) {
        button.classList.remove("selected");
      });

      node.classList.add("selected");

      event.preventDefault();
      return false;
    };

    node.addEventListener("click", submitForm);
  });
});
