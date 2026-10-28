const ajax = require("../js/ajax.js");
const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

function initializePhotoCrop(form) {
  if (!form || form.dataset.photoCropReady) return;

  const input = form.querySelector("[data-crop-input]");
  const cropper = form.querySelector("[data-photo-cropper]");
  const stage = form.querySelector("[data-photo-crop-stage]");
  const image = form.querySelector("[data-crop-image]");
  const outsideImage = form.querySelector("[data-crop-image-outside]");
  const cropMask = form.querySelector("[data-photo-crop-mask]");
  const zoomInput = form.querySelector("[data-photo-zoom]");
  const shapeInputs = form.querySelectorAll("[data-photo-shape]");
  const zoomOut = form.querySelector("[data-photo-zoom-out]");
  const zoomIn = form.querySelector("[data-photo-zoom-in]");
  const fields = {
    x: form.querySelector("[data-crop-x]"),
    y: form.querySelector("[data-crop-y]"),
    width: form.querySelector("[data-crop-width]"),
    height: form.querySelector("[data-crop-height]"),
  };
  if (!input || !cropper || !stage || !image || !outsideImage || !cropMask || !zoomInput) return;
  form.dataset.photoCropReady = "1";

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  const INITIAL_ZOOM = 1.05;
  const limit = (value, min, max) => Math.min(max, Math.max(min, value));
  const pointers = new Map();
  const squircleClip = `polygon(${Array.from({ length: 256 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 256;
    const x = 50 + 50 * Math.sign(Math.cos(angle)) * Math.sqrt(Math.abs(Math.cos(angle)));
    const y = 50 + 50 * Math.sign(Math.sin(angle)) * Math.sqrt(Math.abs(Math.sin(angle)));
    return `${x.toFixed(3)}% ${y.toFixed(3)}%`;
  }).join(", ")})`;
  let state;
  let gesture;
  let objectURL;
  let animationFrame;
  let previousSize;

  const stageSize = () => ({ width: stage.clientWidth, height: stage.clientHeight });
  const bounds = () => {
    const { width, height } = stageSize();
    return {
      minX: width - state.baseWidth * state.zoom,
      minY: height - state.baseHeight * state.zoom,
    };
  };
  const write = () => {
    if (!state) return;
    const { width, height } = stageSize();
    const renderedWidth = state.baseWidth * state.zoom;
    const renderedHeight = state.baseHeight * state.zoom;
    const x = limit(state.x, width - renderedWidth, 0);
    const y = limit(state.y, height - renderedHeight, 0);
    const fraction = (value) => limit(Number(value.toFixed(8)), 0, 1);
    // The image's CSS position is a negative translation when the crop starts
    // away from its top-left; the submitted source offsets are positive.
    const cropX = fraction(-x / renderedWidth);
    const cropY = fraction(-y / renderedHeight);

    image.style.width = `${state.baseWidth}px`;
    image.style.height = `${state.baseHeight}px`;
    image.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.zoom})`;
    outsideImage.style.width = `${state.baseWidth}px`;
    outsideImage.style.height = `${state.baseHeight}px`;
    outsideImage.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.zoom})`;
    fields.x.value = cropX;
    fields.y.value = cropY;
    fields.width.value = Math.min(fraction(width / renderedWidth), 1 - cropX);
    fields.height.value = Math.min(fraction(height / renderedHeight), 1 - cropY);
    zoomInput.value = String(Math.round(state.zoom * 100));
    zoomInput.setAttribute("aria-valuetext", `${Math.round(state.zoom * 100)}%`);
    if (zoomOut) zoomOut.disabled = state.zoom <= MIN_ZOOM;
    if (zoomIn) zoomIn.disabled = state.zoom >= MAX_ZOOM;
  };
  const stopPhysics = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;
  };
  const applyBounds = () => {
    const { minX, minY } = bounds();
    state.x = limit(state.x, minX, 0);
    state.y = limit(state.y, minY, 0);
  };
  const animateToBounds = () => {
    stopPhysics();
    const { minX, minY } = bounds();
    const outside = state.x < minX || state.x > 0 || state.y < minY || state.y > 0;
    if (!outside) return;

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      applyBounds();
      write();
      return;
    }

    let vx = 0;
    let vy = 0;
    let steps = 0;
    const tick = () => {
      const { minX, minY } = bounds();
      const targetX = limit(state.x, minX, 0);
      const targetY = limit(state.y, minY, 0);
      vx += (targetX - state.x) * 0.09;
      vy += (targetY - state.y) * 0.09;
      vx *= 0.74;
      vy *= 0.74;
      state.x += vx;
      state.y += vy;
      write();

      steps += 1;
      if (steps < 120 && (Math.abs(vx) > 0.12 || Math.abs(vy) > 0.12 || Math.abs(targetX - state.x) > 0.12 || Math.abs(targetY - state.y) > 0.12)) {
        animationFrame = requestAnimationFrame(tick);
      } else {
        applyBounds();
        write();
        animationFrame = null;
      }
    };
    animationFrame = requestAnimationFrame(tick);
  };
  const point = (event) => {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const setZoom = (nextZoom, anchor) => {
    if (!state) return;
    const { width, height } = stageSize();
    const center = anchor || { x: width / 2, y: height / 2 };
    const zoom = limit(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const ratio = zoom / state.zoom;
    state.x = center.x - (center.x - state.x) * ratio;
    state.y = center.y - (center.y - state.y) * ratio;
    state.zoom = zoom;
    applyBounds();
    write();
  };
  const imagePointAt = (center) => ({
    x: (center.x - state.x) / state.zoom,
    y: (center.y - state.y) / state.zoom,
  });
  const startPan = (id, position) => {
    gesture = {
      type: "pan",
      id,
      pointer: position,
      x: state.x,
      y: state.y,
    };
  };
  const startPinch = () => {
    const entries = [...pointers.entries()].slice(0, 2);
    const a = entries[0][1];
    const b = entries[1][1];
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gesture = {
      type: "pinch",
      ids: entries.map(([id]) => id),
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: state.zoom,
      center,
      imagePoint: imagePointAt(center),
    };
  };
  const movePointer = (event) => {
    if (!pointers.has(event.pointerId) || !state) return;
    event.preventDefault();
    const position = point(event);
    pointers.set(event.pointerId, position);

    if (pointers.size >= 2) {
      if (!gesture || gesture.type !== "pinch") startPinch();
      const a = pointers.get(gesture.ids[0]);
      const b = pointers.get(gesture.ids[1]);
      if (!a || !b) return;
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      state.zoom = limit(gesture.zoom * distance / gesture.distance, MIN_ZOOM, MAX_ZOOM);
      state.x = center.x - gesture.imagePoint.x * state.zoom;
      state.y = center.y - gesture.imagePoint.y * state.zoom;
      applyBounds();
      write();
      return;
    }

    if (!gesture || gesture.type !== "pan" || gesture.id !== event.pointerId) startPan(event.pointerId, position);
    const dx = position.x - gesture.pointer.x;
    const dy = position.y - gesture.pointer.y;
    const { minX, minY } = bounds();
    const resist = (value, min, max) => {
      if (value < min) return min - Math.min(18, (min - value) * 0.2);
      if (value > max) return max + Math.min(18, (value - max) * 0.2);
      return value;
    };
    state.x = resist(gesture.x + position.x - gesture.pointer.x, minX, 0);
    state.y = resist(gesture.y + position.y - gesture.pointer.y, minY, 0);
    write();
  };
  const endPointer = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);

    if (pointers.size >= 2) {
      startPinch();
    } else if (pointers.size === 1) {
      const [id, position] = [...pointers.entries()][0];
      startPan(id, position);
    } else {
      gesture = null;
      stage.classList.remove("is-dragging");
      animateToBounds();
    }
  };
  const reset = () => {
    if (!state) return;
    const { width, height } = stageSize();
    state.zoom = INITIAL_ZOOM;
    state.x = (width - state.baseWidth * state.zoom) / 2;
    state.y = (height - state.baseHeight * state.zoom) / 2;
    applyBounds();
    write();
  };

  const updateShape = () => {
    const selected = form.querySelector("[data-photo-shape]:checked");
    cropper.dataset.shape = selected ? selected.value : "square";
    const frame = cropper.querySelector(".photo-cropper__frame");
    const clipPath = selected && selected.value === "squircle" ? squircleClip : "";
    cropMask.style.clipPath = clipPath;
    if (frame) frame.style.clipPath = clipPath;
  };
  const loadFile = (file) => {
    stopPhysics();
    pointers.clear();
    gesture = null;
    state = null;
    fields.x.value = fields.y.value = fields.width.value = fields.height.value = "";
    zoomInput.value = String(INITIAL_ZOOM * 100);
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = null;

    if (!file) {
      cropper.hidden = true;
      image.removeAttribute("src");
      outsideImage.removeAttribute("src");
      fields.x.value = fields.y.value = fields.width.value = fields.height.value = "";
      return;
    }

    objectURL = URL.createObjectURL(file);
    const selectedURL = objectURL;
    cropper.hidden = false;
    outsideImage.src = selectedURL;
    image.onload = () => {
      if (objectURL !== selectedURL) return;
      requestAnimationFrame(() => {
        if (objectURL !== selectedURL) return;
        const { width, height } = stageSize();
        if (!width || !height || !image.naturalWidth || !image.naturalHeight) {
          cropper.hidden = true;
          return;
        }
        const fit = Math.max(width / image.naturalWidth, height / image.naturalHeight);
        state = {
          baseWidth: image.naturalWidth * fit,
          baseHeight: image.naturalHeight * fit,
          zoom: INITIAL_ZOOM,
          x: 0,
          y: 0,
        };
        state.x = (width - state.baseWidth * state.zoom) / 2;
        state.y = (height - state.baseHeight * state.zoom) / 2;
        previousSize = { width, height };
        applyBounds();
        write();
        stage.focus({ preventScroll: true });
      });
    };
    image.onerror = () => {
      if (objectURL === selectedURL) cropper.hidden = true;
    };
    image.src = selectedURL;
  };

  input.addEventListener("change", () => loadFile(input.files && input.files[0]));
  if (input.files && input.files[0]) loadFile(input.files[0]);

  stage.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    event.preventDefault();
    stopPhysics();
    pointers.set(event.pointerId, point(event));
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
    if (pointers.size >= 2) startPinch();
    else startPan(event.pointerId, pointers.get(event.pointerId));
  });
  stage.addEventListener("pointermove", movePointer);
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  stage.addEventListener("lostpointercapture", endPointer);
  stage.addEventListener("wheel", (event) => {
    if (!state) return;
    event.preventDefault();
    setZoom(state.zoom * Math.exp(-event.deltaY * 0.0015), point(event));
  }, { passive: false });
  stage.addEventListener("keydown", (event) => {
    if (!state) return;
    const { width, height } = stageSize();
    const amount = Math.max(2, Math.round(width * (event.shiftKey ? 0.1 : 0.02)));
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "ArrowLeft") state.x -= amount;
      if (event.key === "ArrowRight") state.x += amount;
      if (event.key === "ArrowUp") state.y -= amount;
      if (event.key === "ArrowDown") state.y += amount;
      applyBounds();
      write();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom(state.zoom + 0.1);
    } else if (event.key === "-") {
      event.preventDefault();
      setZoom(state.zoom - 0.1);
    } else if (event.key === "0") {
      event.preventDefault();
      reset();
    }
  });

  zoomInput.addEventListener("input", () => setZoom(Number(zoomInput.value) / 100));
  if (zoomOut) zoomOut.addEventListener("click", () => setZoom(state && state.zoom - 0.1));
  if (zoomIn) zoomIn.addEventListener("click", () => setZoom(state && state.zoom + 0.1));
  shapeInputs.forEach((input) => input.addEventListener("change", updateShape));
  updateShape();

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      const nextSize = stageSize();
      if (!nextSize.width || !nextSize.height) return;
      if (!state || !previousSize || !previousSize.width || !previousSize.height) {
        previousSize = nextSize;
        return;
      }
      const centerX = (previousSize.width / 2 - state.x) / (state.baseWidth * state.zoom);
      const centerY = (previousSize.height / 2 - state.y) / (state.baseHeight * state.zoom);
      const fit = Math.max(nextSize.width / image.naturalWidth, nextSize.height / image.naturalHeight);
      state.baseWidth = image.naturalWidth * fit;
      state.baseHeight = image.naturalHeight * fit;
      state.x = nextSize.width / 2 - centerX * state.baseWidth * state.zoom;
      state.y = nextSize.height / 2 - centerY * state.baseHeight * state.zoom;
      applyBounds();
      write();
      previousSize = nextSize;
    }).observe(stage);
    previousSize = stageSize();
  }

  window.addEventListener("pagehide", () => {
    stopPhysics();
    if (objectURL) URL.revokeObjectURL(objectURL);
  }, { once: true });
}

function initializeSavedPhotoMask() {
  const form = document.querySelector("[data-photo-mask-form]");
  const preview = document.querySelector("[data-profile-mask-preview]");
  if (!form || !preview) return;

  const errorNotice = form.querySelector("[data-photo-mask-error]");
  const shapeInputs = form.querySelectorAll("[data-photo-shape]");
  let savedMask = preview.dataset.profileMask || "square";
  let changeNumber = 0;
  let saveQueue = Promise.resolve();

  form.addEventListener("change", (event) => {
    if (!event.target.matches("[data-photo-shape]")) return;

    const selectedMask = event.target.value;
    const thisChange = ++changeNumber;
    preview.dataset.profileMask = selectedMask;
    if (errorNotice) errorNotice.hidden = true;

    saveQueue = saveQueue.catch(() => {}).then(async () => {
      // If another shape was chosen while a save was in flight, save only the
      // latest choice after the active request has finished.
      if (thisChange !== changeNumber) return;

      const response = await fetch(withAjax(form.action), {
        method: "POST",
        body: new FormData(form),
        credentials: "same-origin",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result && result.error || "We couldn't save your photo. Please try again.");
      }

      savedMask = selectedMask;
      handleAjaxSaveResponse(response);
    }).catch((error) => {
      if (thisChange !== changeNumber) return;

      const fallback = [...shapeInputs].find((input) => input.value === savedMask);
      if (fallback) fallback.checked = true;
      preview.dataset.profileMask = savedMask;
      if (errorNotice) {
        errorNotice.textContent = error.message || "We couldn't save your photo. Please try again.";
        errorNotice.hidden = false;
      }
    });
  });
}

module.exports = initializePhotoCrop;

if (typeof document !== "undefined") {
  initializePhotoCrop(document.querySelector("[data-photo-crop-form]"));
  initializeSavedPhotoMask();
}
