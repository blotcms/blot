function initializeCrop(form) {
  if (!form || form.dataset.cropReady) return;

  const input = form.querySelector("[data-crop-input]");
  if (!input) return;
  form.dataset.cropReady = "1";

  const cropper = form.querySelector("[data-cropper]");
  const image = form.querySelector("[data-crop-image]");
  const selection = form.querySelector("[data-crop-selection]");
  const handles = form.querySelector("[data-crop-handles]");
  const fields = {
    x: form.querySelector("[data-crop-x]"),
    y: form.querySelector("[data-crop-y]"),
    width: form.querySelector("[data-crop-width]"),
    height: form.querySelector("[data-crop-height]"),
  };
  let current;
  let drag;
  let objectURL;

  const limit = (value, min, max) => Math.min(max, Math.max(min, value));
  const dimensions = () => ({ width: image.clientWidth, height: image.clientHeight });
  const write = (persist = true) => {
    const { width, height } = dimensions();
    selection.style.left = `${current.left}px`;
    selection.style.top = `${current.top}px`;
    selection.style.width = `${current.width}px`;
    selection.style.height = `${current.height}px`;
    handles.style.left = `${current.left}px`;
    handles.style.top = `${current.top}px`;
    handles.style.width = `${current.width}px`;
    handles.style.height = `${current.height}px`;

    if (persist) {
      fields.x.value = current.left / width;
      fields.y.value = current.top / height;
      fields.width.value = current.width / width;
      fields.height.value = current.height / height;
    }

    selection.setAttribute(
      "aria-description",
      `Crop is ${Math.round(current.width / width * 100)}% wide and ${Math.round(current.height / height * 100)}% high.`
    );
  };

  const point = (event) => {
    const rect = image.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const loadFile = (file, restoreCrop = false) => {
    if (!file) {
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = null;
      current = null;
      cropper.hidden = true;
      image.removeAttribute("src");
      fields.x.value = "";
      fields.y.value = "";
      fields.width.value = "";
      fields.height.value = "";
      return;
    }

    // Cropping is optional: coordinates are submitted only after the user
    // moves or resizes the full-image starting frame.
    if (!restoreCrop) {
      fields.x.value = "";
      fields.y.value = "";
      fields.width.value = "";
      fields.height.value = "";
    }

    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(file);
    const selectedURL = objectURL;
    cropper.hidden = false;
    image.onload = () => {
      if (objectURL !== selectedURL) return;
      requestAnimationFrame(() => {
        if (objectURL !== selectedURL) return;
        const { width, height } = dimensions();
        if (!width || !height) {
          cropper.hidden = true;
          return;
        }
        const crop = restoreCrop && [fields.x.value, fields.y.value, fields.width.value, fields.height.value]
          .map(Number);
        const hasRestoredCrop = crop && crop.every(Number.isFinite) &&
          crop[0] >= 0 && crop[1] >= 0 && crop[2] > 0 && crop[3] > 0 &&
          crop[0] + crop[2] <= 1 && crop[1] + crop[3] <= 1;
        current = hasRestoredCrop
          ? { left: crop[0] * width, top: crop[1] * height, width: crop[2] * width, height: crop[3] * height }
          : { left: 0, top: 0, width, height };
        write(false);
      });
    };
    image.onerror = () => {
      if (objectURL === selectedURL) cropper.hidden = true;
    };
    image.src = selectedURL;
  };

  input.addEventListener("change", () => loadFile(input.files && input.files[0]));
  if (input.files && input.files[0]) loadFile(input.files[0], true);

  const beginDrag = (event) => {
    if (!current) return;
    const cornerHandle = event.target.closest("[data-crop-handle]");
    const edgeHandle = event.target.closest("[data-crop-edge]");
    const cropSelection = event.target.closest("[data-crop-selection]");
    if (!cornerHandle && !edgeHandle && !cropSelection) return;
    event.preventDefault();
    const crop = { ...current };
    const corner = cornerHandle && cornerHandle.dataset.cropHandle;
    drag = {
      corner,
      edge: edgeHandle && edgeHandle.dataset.cropEdge,
      start: point(event),
      crop,
    };
    cropper.querySelector(".favicon-cropper__image").setPointerCapture(event.pointerId);
  };

  const imageWrap = cropper.querySelector(".favicon-cropper__image");
  imageWrap.addEventListener("pointerdown", beginDrag);
  imageWrap.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const { width, height } = dimensions();
    const now = point(event);
    const dx = now.x - drag.start.x;
    const dy = now.y - drag.start.y;
    const crop = drag.crop;

    if (!drag.corner && !drag.edge) {
      current.left = limit(crop.left + dx, 0, width - crop.width);
      current.top = limit(crop.top + dy, 0, height - crop.height);
    } else if (drag.corner) {
      const minWidth = Math.min(24, width);
      const minHeight = Math.min(24, height);
      const west = drag.corner.includes("w");
      const north = drag.corner.includes("n");
      const anchorX = west ? crop.left + crop.width : crop.left;
      const anchorY = north ? crop.top + crop.height : crop.top;
      const maxWidth = west ? anchorX : width - anchorX;
      const maxHeight = north ? anchorY : height - anchorY;
      const aspectRatio = crop.width / crop.height;
      const maxWidthByRatio = Math.min(maxWidth, maxHeight * aspectRatio);
      const minWidthByRatio = Math.min(
        maxWidthByRatio,
        Math.max(minWidth, minHeight * aspectRatio)
      );
      const pointer = now;
      const widthFromX = Math.abs(pointer.x - anchorX);
      const widthFromY = Math.abs(pointer.y - anchorY) * aspectRatio;
      const desiredWidth = Math.abs(widthFromX - crop.width) >= Math.abs(widthFromY - crop.width)
        ? widthFromX
        : widthFromY;
      current.width = limit(desiredWidth, minWidthByRatio, maxWidthByRatio);
      current.height = current.width / aspectRatio;
      current.left = west ? anchorX - current.width : anchorX;
      current.top = north ? anchorY - current.height : anchorY;
    } else {
      const edge = drag.edge;
      const right = crop.left + crop.width;
      const bottom = crop.top + crop.height;
      const minWidth = Math.min(24, width);
      const minHeight = Math.min(24, height);
      current.left = crop.left;
      current.top = crop.top;
      current.width = crop.width;
      current.height = crop.height;

      if (edge === "n") {
        current.top = limit(crop.top + dy, 0, bottom - minHeight);
        current.height = bottom - current.top;
      } else if (edge === "s") {
        current.height = limit(crop.height + dy, minHeight, height - crop.top);
      } else if (edge === "w") {
        current.left = limit(crop.left + dx, 0, right - minWidth);
        current.width = right - current.left;
      } else if (edge === "e") {
        current.width = limit(crop.width + dx, minWidth, width - crop.left);
      }
    }
    write();
  });

  const endDrag = (event) => {
    if (drag && imageWrap.hasPointerCapture(event.pointerId)) {
      imageWrap.releasePointerCapture(event.pointerId);
    }
    drag = null;
  };
  imageWrap.addEventListener("pointerup", endDrag);
  imageWrap.addEventListener("pointercancel", endDrag);

  selection.addEventListener("keydown", (event) => {
    if (!current || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const { width, height } = dimensions();
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -4 : 4;

    if (event.shiftKey) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        current.width = limit(current.width + delta, Math.min(24, width), width - current.left);
      } else {
        current.height = limit(current.height + delta, Math.min(24, height), height - current.top);
      }
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      current.left = limit(current.left + delta, 0, width - current.width);
    } else {
      current.top = limit(current.top + delta, 0, height - current.height);
    }

    write();
  });

  window.addEventListener("pagehide", () => {
    if (objectURL) URL.revokeObjectURL(objectURL);
  }, { once: true });
}

module.exports = initializeCrop;

if (typeof document !== "undefined") {
  initializeCrop(document.querySelector("[data-image-crop-form]"));
}
