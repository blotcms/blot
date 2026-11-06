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

function submitForm(targetForm) {
  const formData = new FormData(targetForm);
  const data = new URLSearchParams();

  formData.forEach((value, key) => {
    data.append(key, value);
  });

  const xhr = new XMLHttpRequest();

  xhr.open("POST", targetForm.action, true);
  xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
  xhr.send(data.toString());
}

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
