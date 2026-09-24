const ajax = require("../js/ajax.js");
const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

document.querySelectorAll("#dateSettings").forEach(function (form) {
  const dateSelect = form.querySelector("#date_display");
  if (!dateSelect) return;

  dateSelect.addEventListener("change", (event) => {
    const body = new URLSearchParams();

    if (dateSelect.value === dateSelect.dataset.hideDatesValue) {
      body.append("locals.hide_dates", "on");
    } else {
      body.append(dateSelect.name, dateSelect.value);
      body.append("locals.hide_dates", "off");
    }

    const csrfInput = form.querySelector('input[name="_csrf"]');
    if (csrfInput) body.append(csrfInput.name, csrfInput.value);

    fetch(withAjax(window.location.href), { method: "post", body }).then(
      handleAjaxSaveResponse
    );
    event.preventDefault();
    return false;
  });
});
