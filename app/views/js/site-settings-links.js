const formatInputs = document.querySelectorAll('input[name="format"]');

if (!formatInputs.length) {
  return;
}

const form = formatInputs[0].form;

if (!form || !form.classList.contains("dashboard-form")) {
  return;
}

const customInput = form.querySelector('input[name="custom"]');
const customButtons = form.querySelector(".buttons");

if (!customInput || !customButtons) {
  return;
}

// Saved like the other settings, so the sync status shows it
const { submitForm } = require("./site-settings-autosubmit.js");

function toggleCustomControls(selectedFormat) {
  if (selectedFormat === "") {
    customButtons.style.display = "flex";
    customInput.style.display = "block";
    return;
  }

  customButtons.style.display = "none";
  customInput.style.display = "none";
}

formatInputs.forEach((radio) => {
  radio.addEventListener("change", function (event) {
    toggleCustomControls(event.target.value);
    submitForm(form);
  });
});

const selectedFormat = form.querySelector('input[name="format"]:checked');
if (selectedFormat) {
  toggleCustomControls(selectedFormat.value);
}
