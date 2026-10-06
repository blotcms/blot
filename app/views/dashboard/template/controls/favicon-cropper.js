module.exports = function createFaviconCropper(root, fieldsRoot = root) {
  const cropper = root.querySelector("[data-favicon-cropper]");
  const image = root.querySelector("[data-favicon-image]");
  const selection = root.querySelector("[data-favicon-selection]");
  const previews = root.querySelector("[data-favicon-previews]");
  const previewImages = Array.from(previews.querySelectorAll("img"));
  const fields = {
    x: fieldsRoot.querySelector("[data-favicon-crop-x]"),
    y: fieldsRoot.querySelector("[data-favicon-crop-y]"),
    size: fieldsRoot.querySelector("[data-favicon-crop-size]"),
  };
  let crop;
  let drag;

  const limit = (value, min, max) => Math.min(max, Math.max(min, value));
  const percent = (value) => Math.round(value * 100);
  const dimensions = () => ({ width: image.clientWidth, height: image.clientHeight });

  const renderPreviews = () => {
    if (!crop || !image.naturalWidth || !image.clientWidth) return;
    const scale = image.naturalWidth / image.clientWidth;
    for (const preview of previewImages) {
      const size = Number(preview.dataset.faviconPreview) || 32;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      context.imageSmoothingEnabled = size > 32;
      try {
        context.drawImage(image, crop.left * scale, crop.top * scale, crop.side * scale, crop.side * scale, 0, 0, size, size);
        preview.src = canvas.toDataURL("image/png");
      } catch (_) {
        preview.src = image.src;
      }
    }
  };

  const writeCrop = () => {
    const { width, height } = dimensions();
    selection.style.left = `${crop.left}px`;
    selection.style.top = `${crop.top}px`;
    selection.style.width = selection.style.height = `${crop.side}px`;
    fields.x.value = crop.left / width;
    fields.y.value = crop.top / height;
    fields.size.value = crop.side / Math.min(width, height);
    selection.setAttribute("aria-valuenow", Math.round((crop.left / Math.max(1, width - crop.side)) * 100));
    selection.setAttribute(
      "aria-valuetext",
      `Crop position: ${percent(fields.x.value)}% from the left, ${percent(fields.y.value)}% from the top; size: ${percent(fields.size.value)}% of the shorter image edge.`
    );
    renderPreviews();
  };

  const point = (event) => {
    const rect = image.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const load = (source, options = {}) => new Promise((resolve, reject) => {
    cropper.hidden = false;
    image.onload = () => {
      // The dialog section is shown by the caller before load(). Wait for the
      // browser to lay out the image before measuring its displayed size.
      requestAnimationFrame(() => {
        const { width, height } = dimensions();
        if (!width || !height) {
          cropper.hidden = true;
          reject(new Error("The selected image could not be displayed."));
          return;
        }
        const side = Math.min(width, height);
        crop = { left: (width - side) / 2, top: (height - side) / 2, side };
        const square = image.naturalWidth === image.naturalHeight;
        cropper.hidden = square && options.hideSquareCrop;
        previews.hidden = false;
        writeCrop();
        resolve({ square });
      });
    };
    image.onerror = () => {
      cropper.hidden = true;
      reject(new Error("The selected image could not be loaded."));
    };
    image.src = source;
  });

  selection.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const rect = selection.getBoundingClientRect();
    drag = { mode: event.clientX >= rect.right - 24 && event.clientY >= rect.bottom - 24 ? "resize" : "move", start: point(event), crop: { ...crop } };
    selection.setPointerCapture(event.pointerId);
  });
  selection.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const { width, height } = dimensions();
    const now = point(event);
    const dx = now.x - drag.start.x;
    const dy = now.y - drag.start.y;
    if (drag.mode === "move") {
      crop.left = limit(drag.crop.left + dx, 0, width - crop.side);
      crop.top = limit(drag.crop.top + dy, 0, height - crop.side);
    } else {
      crop.side = limit(drag.crop.side + Math.max(dx, dy), 24, Math.min(width - crop.left, height - crop.top));
    }
    writeCrop();
  });
  const endDrag = (event) => {
    if (drag && selection.hasPointerCapture(event.pointerId)) selection.releasePointerCapture(event.pointerId);
    drag = null;
  };
  selection.addEventListener("pointerup", endDrag);
  selection.addEventListener("pointercancel", endDrag);
  selection.addEventListener("keydown", (event) => {
    if (!crop || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const { width, height } = dimensions();
    if (event.shiftKey) crop.side = limit(crop.side + delta * 4, 24, Math.min(width - crop.left, height - crop.top));
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") crop.left = limit(crop.left + delta * 4, 0, width - crop.side);
    else crop.top = limit(crop.top + delta * 4, 0, height - crop.side);
    writeCrop();
  });

  return { load, focus: () => selection.focus() };
};
