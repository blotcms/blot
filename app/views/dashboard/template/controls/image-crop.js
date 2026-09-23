module.exports = function initializeCrop(form, options) {
  if (!form || form.dataset.cropReady) return;
  form.dataset.cropReady = "1"; options = options || {};
  const favicon = form.hasAttribute("data-favicon-form");
  const input = form.querySelector(favicon ? "[data-favicon-input]" : "[data-crop-input]");
  const cropper = form.querySelector(favicon ? "[data-favicon-cropper]" : "[data-cropper]");
  const image = form.querySelector(favicon ? "[data-favicon-image]" : "[data-crop-image]");
  const selection = form.querySelector(favicon ? "[data-favicon-selection]" : "[data-crop-selection]");
  const fields = { x: form.querySelector(favicon ? "[data-favicon-crop-x]" : "[data-crop-x]"), y: form.querySelector(favicon ? "[data-favicon-crop-y]" : "[data-crop-y]"), size: form.querySelector(favicon ? "[data-favicon-crop-size]" : "[data-crop-size]") };
  let current, drag;
  const limit = (value, min, max) => Math.min(max, Math.max(min, value));
  const write = () => { const width = image.clientWidth, height = image.clientHeight; Object.assign(selection.style, { left: `${current.left}px`, top: `${current.top}px`, width: `${current.side}px`, height: `${current.side}px` }); fields.x.value = current.left / width; fields.y.value = current.top / height; fields.size.value = current.side / Math.min(width, height); if (options.onChange) options.onChange(current, image); };
  input.addEventListener("change", () => { const file = input.files && input.files[0]; if (!file) return; image.onload = () => { const width = image.clientWidth, height = image.clientHeight, side = Math.min(width, height); current = { left: (width - side) / 2, top: (height - side) / 2, side }; cropper.hidden = false; if (options.required) write(); if (options.onLoad) options.onLoad(current, image); }; image.src = URL.createObjectURL(file); });
  const point = (event) => { const box = image.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  selection.addEventListener("pointerdown", (event) => { event.preventDefault(); write(); const box = selection.getBoundingClientRect(); drag = { resize: event.clientX >= box.right - 24 && event.clientY >= box.bottom - 24, start: point(event), crop: { ...current } }; selection.setPointerCapture(event.pointerId); });
  selection.addEventListener("pointermove", (event) => { if (!drag) return; const width = image.clientWidth, height = image.clientHeight, now = point(event), dx = now.x - drag.start.x, dy = now.y - drag.start.y; if (drag.resize) current.side = limit(drag.crop.side + Math.max(dx, dy), 24, Math.min(width - current.left, height - current.top)); else { current.left = limit(drag.crop.left + dx, 0, width - current.side); current.top = limit(drag.crop.top + dy, 0, height - current.side); } write(); });
  const end = (event) => { if (drag && selection.hasPointerCapture(event.pointerId)) selection.releasePointerCapture(event.pointerId); drag = null; };
  selection.addEventListener("pointerup", end); selection.addEventListener("pointercancel", end);
};

module.exports(document.querySelector("[data-image-crop-form]"));
