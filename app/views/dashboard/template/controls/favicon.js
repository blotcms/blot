const crop = require("./image-crop");
const form = document.querySelector("[data-favicon-form]");

if (form) {
  const previews = form.querySelector("[data-favicon-previews]");
  const previewImages = Array.from(previews.querySelectorAll("img"));

  const renderPreviews = (selection, image) => {
    if (!selection || !image.naturalWidth || !image.clientWidth) return;
    const scale = image.naturalWidth / image.clientWidth;
    const sx = selection.left * scale;
    const sy = selection.top * scale;
    const source = selection.side * scale;

    for (const preview of previewImages) {
      const size = Number(preview.getAttribute("data-favicon-preview")) || 32;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      context.imageSmoothingEnabled = size > 32;
      try {
        context.drawImage(image, sx, sy, source, source, 0, 0, size, size);
        preview.src = canvas.toDataURL("image/png");
      } catch (error) {
        preview.src = image.src;
      }
    }
  };

  crop(form, {
    required: true,
    onChange: renderPreviews,
    onLoad: () => { previews.hidden = false; },
  });
}
