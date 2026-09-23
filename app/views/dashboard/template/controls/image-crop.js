function initializeCrop(form) {
  if (!form || form.dataset.cropReady) return;
  form.dataset.cropReady = "1";

  const input = form.querySelector("[data-crop-input]");
  const cropper = form.querySelector("[data-cropper]");
  const image = form.querySelector("[data-crop-image]");
  const selection = form.querySelector("[data-crop-selection]");
  const fields = {
    x: form.querySelector("[data-crop-x]"),
    y: form.querySelector("[data-crop-y]"),
    size: form.querySelector("[data-crop-size]"),
  };
  let current;
  let drag;
  let objectURL;

  const limit = (value, min, max) => Math.min(max, Math.max(min, value));
  const dimensions = () => ({ width: image.clientWidth, height: image.clientHeight });
  const percent = (value) => Math.round(value * 100);

  const write = (persist = true) => {
    const { width, height } = dimensions();
    selection.style.left = `${current.left}px`;
    selection.style.top = `${current.top}px`;
    selection.style.width = selection.style.height = `${current.side}px`;

    if (persist) {
      fields.x.value = current.left / width;
      fields.y.value = current.top / height;
      fields.size.value = current.side / Math.min(width, height);
    }

    selection.setAttribute(
      "aria-valuenow",
      Math.round((current.left / Math.max(1, width - current.side)) * 100)
    );
    selection.setAttribute(
      "aria-valuetext",
      `Crop position: ${percent(current.left / width)}% from the left, ${percent(current.top / height)}% from the top; size: ${percent(current.side / Math.min(width, height))}% of the shorter image edge.`
    );
  };

  const point = (event) => {
    const rect = image.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;

    // A crop only applies to the file selected when those coordinates were
    // entered. Keep the centered preview optional for each new selection.
    fields.x.value = "";
    fields.y.value = "";
    fields.size.value = "";

    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(file);
    cropper.hidden = false;
    image.onload = () => {
      requestAnimationFrame(() => {
        const { width, height } = dimensions();
        if (!width || !height) {
          cropper.hidden = true;
          return;
        }
        const side = Math.min(width, height);
        current = { left: (width - side) / 2, top: (height - side) / 2, side };
        // The preview shows a centered starting square, but remains optional:
        // only interacting with it sends crop coordinates to the server.
        write(false);
      });
    };
    image.onerror = () => {
      cropper.hidden = true;
    };
    image.src = objectURL;
  });

  const beginDrag = (event) => {
    if (!current) return;
    event.preventDefault();
    const rect = selection.getBoundingClientRect();
    drag = {
      resize: event.clientX >= rect.right - 24 && event.clientY >= rect.bottom - 24,
      start: point(event),
      crop: { ...current },
    };
    selection.setPointerCapture(event.pointerId);
    write();
  };

  selection.addEventListener("pointerdown", beginDrag);
  selection.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const { width, height } = dimensions();
    const now = point(event);
    const dx = now.x - drag.start.x;
    const dy = now.y - drag.start.y;

    if (drag.resize) {
      current.side = limit(
        drag.crop.side + Math.max(dx, dy),
        24,
        Math.min(width - current.left, height - current.top)
      );
    } else {
      current.left = limit(drag.crop.left + dx, 0, width - current.side);
      current.top = limit(drag.crop.top + dy, 0, height - current.side);
    }
    write();
  });

  const endDrag = (event) => {
    if (drag && selection.hasPointerCapture(event.pointerId)) {
      selection.releasePointerCapture(event.pointerId);
    }
    drag = null;
  };
  selection.addEventListener("pointerup", endDrag);
  selection.addEventListener("pointercancel", endDrag);

  selection.addEventListener("keydown", (event) => {
    if (!current || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const { width, height } = dimensions();

    if (event.shiftKey) {
      current.side = limit(
        current.side + delta * 4,
        24,
        Math.min(width - current.left, height - current.top)
      );
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      current.left = limit(current.left + delta * 4, 0, width - current.side);
    } else {
      current.top = limit(current.top + delta * 4, 0, height - current.side);
    }

    write();
  });

  window.addEventListener("pagehide", () => {
    if (objectURL) URL.revokeObjectURL(objectURL);
  }, { once: true });
};

module.exports = initializeCrop;

if (typeof document !== "undefined") {
  initializeCrop(document.querySelector("[data-image-crop-form]"));
}
