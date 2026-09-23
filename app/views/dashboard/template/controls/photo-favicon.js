const createFaviconCropper = require("./favicon-cropper");

const form = document.querySelector("[data-photo-form]");

if (form) {
  const input = form.querySelector("[data-photo-input]");
  const dialog = form.querySelector("[data-photo-favicon-dialog]");
  const prompt = dialog.querySelector("[data-photo-favicon-prompt]");
  const crop = dialog.querySelector("[data-photo-favicon-crop]");
  const errorMessage = dialog.querySelector("[data-photo-favicon-error]");
  const useButton = dialog.querySelector("[data-photo-use-as-favicon]");
  const useField = form.querySelector("[data-photo-use-favicon]");
  const cropper = createFaviconCropper(dialog, form);
  let selectedFile;
  let objectURL;
  let submitting = false;

  const cleanup = () => {
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = null;
  };
  const submit = (withFavicon) => {
    useField.value = withFavicon ? "1" : "0";
    submitting = true;
    dialog.close();
    form.requestSubmit();
  };

  form.addEventListener("submit", (event) => {
    selectedFile = input.files && input.files[0];
    if (
      submitting ||
      !selectedFile ||
      form.dataset.faviconSupported !== "true" ||
      form.dataset.hasFavicon !== "true"
    ) return;
    event.preventDefault();
    errorMessage.hidden = true;
    prompt.hidden = false;
    crop.hidden = true;
    dialog.showModal();
    useButton.focus();
  });
  dialog.querySelector("[data-photo-skip-favicon]").addEventListener("click", () => submit(false));
  useButton.addEventListener("click", async () => {
    cleanup();
    objectURL = URL.createObjectURL(selectedFile);
    prompt.hidden = true;
    crop.hidden = false;
    errorMessage.hidden = true;
    try {
      const result = await cropper.load(objectURL, { hideSquareCrop: true });
      if (result.square) return submit(true);
      cropper.focus();
    } catch (_) {
      crop.hidden = true;
      prompt.hidden = false;
      errorMessage.hidden = false;
      useButton.focus();
    }
  });
  dialog.querySelector("[data-photo-confirm-crop]").addEventListener("click", () => submit(true));
  dialog.querySelector("[data-photo-cancel-crop]").addEventListener("click", () => {
    crop.hidden = true;
    prompt.hidden = false;
    dialog.querySelector("[data-photo-use-as-favicon]").focus();
  });
  dialog.addEventListener("close", () => {
    cleanup();
    // Dismissing the optional prompt is equivalent to Skip, so the selected
    // photo still saves when the user presses Escape.
    if (!submitting) submit(false);
  });
  window.addEventListener("pagehide", cleanup, { once: true });
}
