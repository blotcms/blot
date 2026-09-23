const createFaviconCropper = require("./favicon-cropper");

const form = document.querySelector("[data-favicon-form]");

if (form) {
  const input = form.querySelector("[data-favicon-input]");
  const cropper = createFaviconCropper(form);
  const loadError = form.querySelector("[data-favicon-load-error]");
  let objectURL;

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(file);
    loadError.hidden = true;
    cropper.load(objectURL).catch(() => {
      loadError.hidden = false;
    });
  });

  window.addEventListener("pagehide", () => {
    if (objectURL) URL.revokeObjectURL(objectURL);
  }, { once: true });
}
