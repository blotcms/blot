const createFaviconCropper = require("./favicon-cropper");

const form = document.querySelector("[data-favicon-form]");

if (form) {
  const input = form.querySelector("[data-favicon-input]");
  const cropper = createFaviconCropper(form);
  let objectURL;

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(file);
    cropper.load(objectURL);
  });

  window.addEventListener("pagehide", () => {
    if (objectURL) URL.revokeObjectURL(objectURL);
  }, { once: true });
}
