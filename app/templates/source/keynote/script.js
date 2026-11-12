{{{app_js}}}

(() => {
  const view = document.body.dataset.view;
  const lightbox = document.querySelector(".lightbox");
  if (!lightbox) return;

  const root = document.documentElement;
  const lightboxFrame = lightbox.querySelector(".lightbox-frame");
  const lightboxImage = lightbox.querySelector(".lightbox-image");
  const closeButton = lightbox.querySelector(".lightbox-close");
  const previousButton = lightbox.querySelector(".lightbox-previous");
  const nextButton = lightbox.querySelector(".lightbox-next");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const SWIPE_THRESHOLD = 56;
  const WHEEL_GAP = 150; // ms of quiet that ends a wheel gesture
  const CONTEXT_KEY = "keynoteContext";

  const mod = (value, length) => ((value % length) + length) % length;
  const isLoaded = (image) => image.complete && image.naturalWidth > 0;
  const absolute = (url) => new URL(url, document.baseURI).href;

  // ---- Entries: one per image link, read from the page ----

  function readEntry(link) {
    const html = link.querySelector("template.entry-html")?.content;
    const original = html?.querySelector("img");
    const width = Number(link.dataset.width) || 1;
    const height = Number(link.dataset.height) || 1;
    return {
      link,
      href: new URL(link.getAttribute("href"), document.baseURI).pathname,
      title: link.getAttribute("aria-label") || "",
      alt: original?.getAttribute("alt") || link.getAttribute("aria-label") || "",
      preview: link.dataset.preview,
      full: original?.getAttribute("src") ? absolute(original.getAttribute("src")) : link.dataset.preview,
      width,
      height,
      fullWidth: Number(original?.getAttribute("width")) || width,
    };
  }

  const loadedImages = new Map();
  function preloadImage(url) {
    if (!loadedImages.has(url)) {
      const image = new Image();
      image.src = url;
      loadedImages.set(url, image.decode().then(() => true, () => false));
    }
    return loadedImages.get(url);
  }

  // ---- The viewer: one lightbox for whichever collection is on the page ----

  let controller = null; // the rail or the grid that supplies entries
  let activeIndex = 0;
  let imageToken = 0;
  let opening = false;
  let closeAfterOpen = false;
  let closing = false;
  let closePending = false;
  let lightboxGesture = null;
  let suppressLightboxClickUntil = 0;
  let wheelLockUntil = 0;

  const lightboxBusy = () => opening || closing || closePending;
  const viewerActive = () => lightbox.open || lightboxBusy();

  function setActive(index) {
    resetZoom();
    const entries = controller.entries();
    activeIndex = controller.wrap ? mod(index, entries.length) : Math.min(entries.length - 1, Math.max(0, index));
    const entry = entries[activeIndex];
    const token = ++imageToken;
    lightboxImage.style.setProperty("--image-ratio", entry.width / entry.height);
    lightboxImage.style.setProperty("--image-width", `${entry.fullWidth}px`);
    lightboxImage.width = entry.width;
    lightboxImage.height = entry.height;
    const source = controller.sourceImage(activeIndex);
    lightboxImage.src = source && isLoaded(source) && source.currentSrc ? source.currentSrc : entry.preview;
    lightboxImage.alt = entry.alt;
    previousButton.disabled = !controller.wrap && activeIndex === 0;
    nextButton.disabled = !controller.wrap && activeIndex === entries.length - 1 && !controller.hasMore?.();
    if (activeIndex >= entries.length - 4) controller.loadMore?.();

    upgradeChain(entry, token);
  }

  // Sharpen in steps: the large thumbnail, then the original. Each is fetched and decoded first
  // and only swapped in once no transition is running, so nothing flickers or waits.
  async function upgradeChain(entry, token) {
    await lightboxImage.decode().catch(() => {});
    for (const url of [entry.preview, entry.full]) {
      if (token !== imageToken) return;
      if (!url || lightboxImage.currentSrc === absolute(url)) continue;
      const ready = await preloadImage(url);
      if (!ready || token !== imageToken) return;
      while (opening || closePending) await new Promise((resolve) => setTimeout(resolve, 50));
      if (token !== imageToken) return;
      // The image is already decoded; decode synchronously so the swap never paints blank.
      lightboxImage.decoding = "sync";
      lightboxImage.addEventListener("load", () => { lightboxImage.decoding = "async"; }, { once: true });
      lightboxImage.src = url;
    }
  }

  function replaceAddress() {
    const entry = controller.entries()[activeIndex];
    history.replaceState({ keynote: "open", pushed: Boolean(history.state?.pushed) }, "", entry.href);
  }

  function step(direction) {
    if (lightboxBusy()) return;
    const entries = controller.entries();
    const next = activeIndex + direction;
    if (!controller.wrap && (next < 0 || next >= entries.length)) {
      if (next >= entries.length) controller.loadMore?.();
      return;
    }
    setActive(next);
    replaceAddress();
  }

  function startSwipe(event) {
    if (!lightbox.open || lightboxBusy() || !event.isPrimary || event.button !== 0 || zoomed()) return;
    lightboxGesture = { id: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    lightboxFrame.setPointerCapture(event.pointerId);
  }

  function moveSwipe(event) {
    if (!lightboxGesture || event.pointerId !== lightboxGesture.id) return;
    const deltaX = event.clientX - lightboxGesture.startX;
    const deltaY = event.clientY - lightboxGesture.startY;
    if (Math.hypot(deltaX, deltaY) > 8) lightboxGesture.moved = true;
  }

  function finishSwipe(event) {
    if (!lightboxGesture || event.pointerId !== lightboxGesture.id) return;
    const gesture = lightboxGesture;
    lightboxGesture = null;
    if (gesture.moved) suppressLightboxClickUntil = performance.now() + 350;
    if (event.type === "pointercancel" || lightboxBusy()) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    step(deltaX < 0 ? 1 : -1);
  }

  function reveal() {
    opening = false;
    lightbox.classList.remove("is-opening");
    if (closeAfterOpen) {
      closeAfterOpen = false;
      void requestClose();
      return;
    }
    lightbox.classList.add("is-revealed");
  }

  // `animate` zooms from the entry's image on the page; without it the viewer simply appears.
  async function open(index, { animate = true } = {}) {
    if (viewerActive() || !controller) return;
    opening = true;
    closeAfterOpen = false;
    controller.pause();
    resetZoom();
    setActive(index);
    const source = animate ? controller.sourceImage(activeIndex) : null;
    // An image still loading opens at once, as its placeholder.
    if (source && isLoaded(source)) await lightboxImage.decode().catch(() => {});

    const show = () => {
      source?.classList.remove("is-transitioning");
      controller.hideSource(activeIndex, true);
      lightbox.classList.remove("is-revealed", "is-closing");
      lightbox.classList.add("is-opening");
      lightbox.showModal();
      root.classList.add("is-viewing");
      lightboxFrame.focus({ preventScroll: true });
    };

    if (!source || reducedMotion.matches || !document.startViewTransition) {
      show();
      reveal();
      return;
    }
    root.classList.add("is-zooming");
    source.classList.add("is-transitioning");
    source.style.viewTransitionName = "active-image";
    const transition = document.startViewTransition(() => {
      source.style.removeProperty("view-transition-name");
      show();
    });
    transition.ready.then(() => {
      if (opening && lightbox.open && !closeAfterOpen) lightbox.classList.add("is-revealed");
    }, () => {});
    transition.finished.then(() => {
      root.classList.remove("is-zooming");
      reveal();
    }, () => {
      root.classList.remove("is-zooming");
      reveal();
    });
  }

  async function close({ animate = true } = {}) {
    if (opening) {
      closeAfterOpen = true;
      return;
    }
    if (!lightbox.open || closePending) return;
    closePending = true;
    // Bring the header back as the viewer starts to leave, not once it has gone.
    root.classList.add("is-leaving");
    // An image mostly still on screen zooms back to where it was; otherwise the page brings it in first.
    controller.settle(activeIndex);
    const source = animate ? controller.sourceImage(activeIndex) : null;
    await Promise.all([source, lightboxImage].filter((image) => image && isLoaded(image)).map((image) => image.decode().catch(() => {})));
    if (!lightbox.open) {
      root.classList.remove("is-leaving");
      closePending = false;
      return;
    }

    const hide = () => {
      controller.hideSource(activeIndex, false);
      lightbox.classList.remove("is-revealed", "is-opening");
      lightbox.classList.add("is-closing");
    };
    const finish = () => {
      root.classList.remove("lightbox-transition-closing", "is-zooming", "is-leaving");
      if (source) {
        source.classList.remove("is-transitioning");
        source.style.removeProperty("view-transition-name");
      }
      lightbox.classList.remove("is-closing", "is-opening", "is-revealed");
      lightbox.close();
      resetZoom();
      root.classList.remove("is-viewing");
      closing = false;
      closePending = false;
      controller.resume();
    };

    if (!source || reducedMotion.matches || !document.startViewTransition) {
      hide();
      finish();
      return;
    }
    closing = true;
    root.classList.add("is-zooming");
    source.classList.add("is-transitioning");
    const transition = document.startViewTransition(() => {
      root.classList.add("lightbox-transition-closing");
      source.style.viewTransitionName = "active-image";
      hide();
    });
    transition.finished.then(finish, finish);
  }

  // ---- Address and history: opening pushes the entry's address, Back closes ----

  function rememberContext() {
    try {
      sessionStorage.setItem(CONTEXT_KEY, JSON.stringify({ url: location.pathname + location.search, view }));
    } catch (error) { /* storage can be unavailable */ }
  }

  function readContext() {
    try {
      return JSON.parse(sessionStorage.getItem(CONTEXT_KEY));
    } catch (error) {
      return null;
    }
  }

  function openFromPage(index) {
    if (viewerActive()) return;
    rememberContext();
    const entry = controller.entries()[index];
    history.pushState({ keynote: "open", pushed: true }, "", entry.href);
    void open(index);
  }

  // Close button, Escape, a click outside the image and so on.
  async function requestClose() {
    if (!lightbox.open && !opening) return;
    if (history.state?.keynote === "open" && history.state.pushed) {
      history.back(); // the popstate handler closes the viewer
      return;
    }
    // Opened directly (or after a reload): go back to the listing it came from, or to the rail.
    const target = directTarget();
    if (target.navigate) {
      window.location.href = target.url;
      return;
    }
    history.replaceState(null, "", target.url);
    await close();
  }

  function directTarget() {
    const context = readContext();
    let sameSite = false;
    try {
      sameSite = new URL(document.referrer).origin === location.origin;
    } catch (error) { /* no referrer */ }
    if (context && sameSite && context.view !== "home" && view !== "home") {
      return { navigate: true, url: context.url };
    }
    return { navigate: false, url: "/" };
  }

  window.addEventListener("popstate", (event) => {
    const state = event.state;
    if (state?.keynote === "open") {
      const index = controller.entries().findIndex((entry) => entry.href === location.pathname);
      if (index >= 0 && !viewerActive()) void open(index);
      else if (index >= 0 && lightbox.open) setActive(index);
      return;
    }
    if (lightbox.open || opening) void close();
  });

  // ---- Zoom: wheel, pinch, buttons and keys enlarge the image up to 200% of its fitted size ----

  const MAX_ZOOM = 2;
  const ZOOM_STEP = 0.5;
  const WHEEL_STEP_DISTANCE = 60; // wheel travel that counts as one zoom step
  const EXIT_PULL_LIMIT = 230; // wheel travel at 100% that closes the viewer
  const PAN_FRICTION = 4.2;
  const PAN_STIFFNESS = 420;
  const PAN_DAMPING = 40;
  const zoomOutButton = lightbox.querySelector(".zoom-out");
  const zoomInButton = lightbox.querySelector(".zoom-in");
  const zoomValue = lightbox.querySelector(".zoom-value");

  let zoomLevel = 1;
  let panX = 0;
  let panY = 0;
  let exitPull = 0;
  let exitTimer = 0;
  let animateTimer = 0;
  let pulledClosed = false;
  let wheelTotal = 0;
  let wheelStamp = 0;
  let stepLockUntil = 0;
  let calmUntil = 0;
  let panDrag = null;
  let panMotion = null;
  let panFrame = 0;
  let pinch = null;
  let lastTap = null;
  let lastDoubleTapAt = 0;
  const pointers = new Map();

  const zoomed = () => zoomLevel > 1.001;
  const clampValue = (value, low, high) => Math.min(high, Math.max(low, value));
  const pullAmount = (distance) => (160 * distance) / (distance + 160);

  // Where the image's centre sits on screen with no zoom or pan applied.
  function baseCenter() {
    return {
      x: lightboxImage.offsetLeft + lightboxImage.offsetWidth / 2,
      y: lightboxImage.offsetTop + lightboxImage.offsetHeight / 2,
    };
  }

  // How far the zoomed image may be moved: its edges stay on or beyond the screen's edges.
  function panBounds(level = zoomLevel) {
    const center = baseCenter();
    const axis = (middle, size, view) => {
      const low = view - middle - size / 2;
      const high = size / 2 - middle;
      return low > high ? [view / 2 - middle, view / 2 - middle] : [low, high];
    };
    const [lowX, highX] = axis(center.x, lightboxImage.offsetWidth * level, lightbox.clientWidth);
    const [lowY, highY] = axis(center.y, lightboxImage.offsetHeight * level, lightbox.clientHeight);
    return { lowX, highX, lowY, highY };
  }

  function renderZoom() {
    const pullScale = reducedMotion.matches ? 1 : 1 - pullAmount(exitPull) / 500;
    const moved = zoomed() || panX || panY || pullScale !== 1;
    lightboxImage.style.transform = moved ? `translate3d(${panX}px, ${panY}px, 0) scale(${zoomLevel * pullScale})` : "";
    lightbox.classList.toggle("is-zoomed", zoomed());
    zoomValue.value = `${Math.round(zoomLevel * 100)}%`;
    zoomOutButton.disabled = !zoomed();
    zoomInButton.disabled = zoomLevel >= MAX_ZOOM - 0.001;
  }

  // Lets the next change to the image's transform glide instead of jump.
  function animateZoom() {
    if (reducedMotion.matches) return;
    lightboxImage.classList.add("is-zoom-animating");
    window.clearTimeout(animateTimer);
    animateTimer = window.setTimeout(() => lightboxImage.classList.remove("is-zoom-animating"), 260);
  }

  function clearPull() {
    window.clearTimeout(exitTimer);
    exitTimer = 0;
    exitPull = 0;
  }

  function stopPan() {
    if (panFrame) cancelAnimationFrame(panFrame);
    panFrame = 0;
    panMotion = null;
    panDrag = null;
    lightbox.classList.remove("is-panning");
  }

  function setZoom(level, pivot = null, { animate = true } = {}) {
    stopPan();
    clearPull();
    const next = clampValue(level, 1, MAX_ZOOM);
    const previous = zoomLevel;
    if (Math.abs(next - previous) < 0.001) {
      renderZoom();
      return;
    }
    if (pivot) {
      const center = baseCenter();
      const px = pivot.x - center.x;
      const py = pivot.y - center.y;
      panX = px - ((px - panX) * next) / previous;
      panY = py - ((py - panY) * next) / previous;
    }
    zoomLevel = next < 1.001 ? 1 : next;
    if (zoomLevel === 1) {
      panX = 0;
      panY = 0;
    } else {
      const bounds = panBounds();
      panX = clampValue(panX, bounds.lowX, bounds.highX);
      panY = clampValue(panY, bounds.lowY, bounds.highY);
    }
    if (animate) animateZoom();
    renderZoom();
    calmUntil = performance.now() + 450;
  }

  function resetZoom() {
    stopPan();
    clearPull();
    window.clearTimeout(animateTimer);
    lightboxImage.classList.remove("is-zoom-animating");
    zoomLevel = 1;
    panX = 0;
    panY = 0;
    pointers.clear();
    pinch = null;
    wheelTotal = 0;
    pulledClosed = false;
    renderZoom();
  }

  const screenCenter = () => ({ x: lightbox.clientWidth / 2, y: lightbox.clientHeight / 2 });

  // Scrolling at 100% pulls the image smaller; far enough closes the viewer, otherwise it springs back.
  function pullToClose(distance) {
    exitPull = Math.min(EXIT_PULL_LIMIT, exitPull + Math.min(distance, 110));
    renderZoom();
    window.clearTimeout(exitTimer);
    if (exitPull >= EXIT_PULL_LIMIT) {
      exitTimer = 0;
      pulledClosed = true;
      void requestClose(); // closes from the pulled size, so the zoom-out starts there
      return;
    }
    exitTimer = window.setTimeout(() => {
      exitTimer = 0;
      exitPull = 0;
      animateZoom();
      renderZoom();
    }, 320);
  }

  function onLightboxWheel(event) {
    wheelLockUntil = performance.now() + WHEEL_GAP;
    event.preventDefault();
    if (lightboxBusy() || pulledClosed) return;
    const now = performance.now();
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? lightbox.clientHeight : 1;
    const deltaY = event.deltaY * unit;
    const deltaX = event.deltaX * unit;
    const pivot = { x: event.clientX, y: event.clientY };
    if (event.ctrlKey) {
      // A trackpad pinch arrives as a wheel event with the control key held.
      setZoom(zoomLevel * Math.exp(-deltaY * 0.01), pivot, { animate: false });
      return;
    }
    if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
    if (now - wheelStamp > 200) wheelTotal = 0;
    wheelStamp = now;
    wheelTotal += deltaY;
    if (now < stepLockUntil) return;
    if (wheelTotal >= WHEEL_STEP_DISTANCE) {
      wheelTotal = 0;
      stepLockUntil = now + 200;
      setZoom(zoomLevel + ZOOM_STEP, pivot);
    } else if (wheelTotal <= -WHEEL_STEP_DISTANCE && zoomed()) {
      wheelTotal = 0;
      stepLockUntil = now + 200;
      setZoom(zoomLevel - ZOOM_STEP, pivot);
    } else if (deltaY < 0 && !zoomed() && now > calmUntil) {
      pullToClose(-deltaY);
    }
  }

  // Panning: drag the enlarged image; it coasts and stretches a little past its edges.
  function elastic(value, low, high, span) {
    if (value > high) {
      const over = value - high;
      return high + (span * over) / (over + span);
    }
    if (value < low) {
      const over = low - value;
      return low - (span * over) / (over + span);
    }
    return value;
  }

  function beginPan(event) {
    stopPan();
    const bounds = panBounds();
    panDrag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPanX: panX,
      startPanY: panY,
      bounds,
      moved: false,
      samples: [{ x: event.clientX, y: event.clientY, time: event.timeStamp }],
    };
    lightbox.setPointerCapture(event.pointerId);
    lightbox.classList.add("is-panning");
    event.preventDefault();
  }

  function movePan(event) {
    const { bounds } = panDrag;
    panDrag.samples.push({ x: event.clientX, y: event.clientY, time: event.timeStamp });
    while (panDrag.samples.length > 2 && event.timeStamp - panDrag.samples[0].time > 100) panDrag.samples.shift();
    if (Math.hypot(event.clientX - panDrag.startX, event.clientY - panDrag.startY) > 5) panDrag.moved = true;
    panX = elastic(panDrag.startPanX + event.clientX - panDrag.startX, bounds.lowX, bounds.highX, lightbox.clientWidth * 0.12);
    panY = elastic(panDrag.startPanY + event.clientY - panDrag.startY, bounds.lowY, bounds.highY, lightbox.clientHeight * 0.12);
    renderZoom();
  }

  function stepAxis(axis, dt) {
    const edge = clampValue(axis.pos, axis.low, axis.high);
    const out = axis.pos - edge;
    if (out) axis.v += (-PAN_STIFFNESS * out - PAN_DAMPING * axis.v) * dt;
    else axis.v *= Math.exp(-PAN_FRICTION * dt);
    axis.pos += axis.v * dt;
    const settled = clampValue(axis.pos, axis.low, axis.high);
    if (out && axis.pos === settled) {
      axis.pos = edge;
      axis.v = 0;
    } else if (axis.pos === settled) {
      if (Math.abs(axis.v) < 2) axis.v = 0;
    } else if (Math.abs(axis.pos - settled) < 0.3 && Math.abs(axis.v) < 8) {
      axis.pos = settled;
      axis.v = 0;
    }
    return axis.v !== 0 || axis.pos !== clampValue(axis.pos, axis.low, axis.high);
  }

  function startPanMotion(velocityX, velocityY) {
    const bounds = panBounds();
    if (reducedMotion.matches) {
      panX = clampValue(panX, bounds.lowX, bounds.highX);
      panY = clampValue(panY, bounds.lowY, bounds.highY);
      renderZoom();
      return;
    }
    panMotion = {
      x: { pos: panX, v: velocityX, low: bounds.lowX, high: bounds.highX },
      y: { pos: panY, v: velocityY, low: bounds.lowY, high: bounds.highY },
    };
    let last = 0;
    const frame = (now) => {
      panFrame = 0;
      if (!panMotion) return;
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      const movingX = stepAxis(panMotion.x, dt);
      const movingY = stepAxis(panMotion.y, dt);
      panX = panMotion.x.pos;
      panY = panMotion.y.pos;
      renderZoom();
      if (movingX || movingY) panFrame = requestAnimationFrame(frame);
      else panMotion = null;
    };
    panFrame = requestAnimationFrame(frame);
  }

  function endPan(event) {
    const gesture = panDrag;
    panDrag = null;
    lightbox.classList.remove("is-panning");
    if (gesture.moved) suppressLightboxClickUntil = performance.now() + 350;
    let velocityX = 0;
    let velocityY = 0;
    if (event.type === "pointerup") {
      const first = gesture.samples[0];
      const last = gesture.samples.at(-1);
      const seconds = Math.max((last.time - first.time) / 1000, 0.001);
      const still = Math.max((event.timeStamp - last.time) / 1000, 0);
      const decay = Math.exp(-PAN_FRICTION * still);
      velocityX = clampValue((last.x - first.x) / seconds, -1100, 1100) * decay;
      velocityY = clampValue((last.y - first.y) / seconds, -1100, 1100) * decay;
    }
    startPanMotion(velocityX, velocityY);
  }

  // Pinching with two fingers zooms around their midpoint and follows them as they move.
  function beginPinch() {
    lightboxGesture = null;
    stopPan();
    const [a, b] = [...pointers.values()];
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    for (const id of pointers.keys()) lightbox.setPointerCapture(id);
  }

  function movePinch() {
    const [a, b] = [...pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const previousMid = pinch.mid;
    setZoom(zoomLevel * (distance / pinch.distance), previousMid, { animate: false });
    if (zoomed()) {
      const bounds = panBounds();
      panX = clampValue(panX + mid.x - previousMid.x, bounds.lowX, bounds.highX);
      panY = clampValue(panY + mid.y - previousMid.y, bounds.lowY, bounds.highY);
      renderZoom();
    }
    pinch = { distance, mid };
  }

  lightbox.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, .zoom-controls") || lightboxBusy()) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, time: event.timeStamp });
    if (pointers.size === 2) beginPinch();
    else if (pointers.size === 1 && zoomed() && event.button === 0) beginPan(event);
  });

  lightbox.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { ...pointers.get(event.pointerId), x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) movePinch();
    else if (panDrag && panDrag.id === event.pointerId) movePan(event);
  });

  const releasePointer = (event) => {
    const entry = pointers.get(event.pointerId);
    if (!entry) return;
    pointers.delete(event.pointerId);
    const wasPinching = Boolean(pinch);
    if (pinch && pointers.size < 2) {
      pinch = null;
      suppressLightboxClickUntil = performance.now() + 350;
      if (zoomed()) {
        animateZoom();
        const bounds = panBounds();
        panX = clampValue(panX, bounds.lowX, bounds.highX);
        panY = clampValue(panY, bounds.lowY, bounds.highY);
      }
      renderZoom();
    } else if (panDrag && panDrag.id === event.pointerId) {
      endPan(event);
    }
    if (!wasPinching) detectDoubleTap(event, entry);
  };

  // Touch screens don't reliably send a double-click, so two quick taps on the image are timed here.
  function detectDoubleTap(event, entry) {
    if (event.type !== "pointerup" || event.pointerType === "mouse" || lightboxBusy()) return;
    const moved = Math.hypot(event.clientX - entry.startX, event.clientY - entry.startY);
    if (moved > 10 || event.timeStamp - entry.time > 300) return;
    if (!zoomed() && event.target !== lightboxImage) return;
    if (lastTap && event.timeStamp - lastTap.time < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 40) {
      lastTap = null;
      lastDoubleTapAt = performance.now();
      setZoom(zoomed() ? 1 : MAX_ZOOM, { x: event.clientX, y: event.clientY });
    } else {
      lastTap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    }
  }
  lightbox.addEventListener("pointerup", releasePointer);
  lightbox.addEventListener("pointercancel", releasePointer);

  lightboxImage.addEventListener("dblclick", (event) => {
    // A touch double-tap has already been handled from its pointer events.
    if (lightboxBusy() || performance.now() - lastDoubleTapAt < 600) return;
    setZoom(zoomed() ? 1 : MAX_ZOOM, { x: event.clientX, y: event.clientY });
  });

  zoomInButton.addEventListener("click", () => setZoom(zoomLevel + ZOOM_STEP, screenCenter()));
  zoomOutButton.addEventListener("click", () => setZoom(zoomLevel - ZOOM_STEP, screenCenter()));

  function zoomKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "+" || event.key === "=") setZoom(zoomLevel + ZOOM_STEP, screenCenter());
    else if (event.key === "-" || event.key === "_") setZoom(zoomLevel - ZOOM_STEP, screenCenter());
    else if (event.key === "0") setZoom(1);
    else return false;
    event.preventDefault();
    return true;
  }

  // ---- Viewer events ----

  closeButton.addEventListener("click", requestClose);
  previousButton.addEventListener("click", () => step(-1));
  nextButton.addEventListener("click", () => step(1));
  lightbox.addEventListener("click", (event) => {
    const suppress = performance.now() < suppressLightboxClickUntil;
    suppressLightboxClickUntil = 0;
    if (event.target !== lightbox) return;
    if (suppress) event.preventDefault();
    else requestClose();
  });
  lightboxFrame.addEventListener("pointerdown", startSwipe);
  lightboxFrame.addEventListener("pointermove", moveSwipe);
  lightboxFrame.addEventListener("pointerup", finishSwipe);
  lightboxFrame.addEventListener("pointercancel", finishSwipe);
  lightbox.addEventListener("wheel", onLightboxWheel, { passive: false });
  lightbox.addEventListener("cancel", (event) => {
    event.preventDefault();
    requestClose();
  });
  lightbox.addEventListener("close", () => {
    lightboxGesture = null;
  });

  window.addEventListener("keydown", (event) => {
    if (lightbox.open) {
      if (zoomKey(event)) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        void requestClose();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        step(event.key === "ArrowRight" ? 1 : -1);
      }
      return;
    }
    controller?.keydown?.(event);
  });

  // ---- Controllers ----

  function fadeImagesIn(images) {
    for (const img of images) {
      if (isLoaded(img)) img.classList.add("is-loaded");
      else img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
    }
  }

  // A rail of slides that drifts, drags, and wraps round as a ring. With few images the
  // set is repeated so the ring always fills the screen.
  function createRail() {
    const viewport = document.querySelector(".rail-viewport");
    const list = viewport.querySelector(".rail");
    const sources = [...list.querySelectorAll(".slide:not([hidden])")];
    if (!sources.length) return null;

    const DRIFT_SPEED = 8; // px per second
    const FRICTION = 4.2;
    const MAX_VELOCITY = 1100;

    const entries = sources.map((slot) => readEntry(slot.querySelector(".item")));
    const entryIndexOf = new Map(entries.map((entry, index) => [entry.href, index]));
    // The entry page also names the entry being shown, which may not be in the rail.
    const current = document.querySelector(".current-entry .item[data-preview]");
    let currentIndex = -1;
    if (current) {
      const entry = readEntry(current);
      currentIndex = entryIndexOf.has(entry.href) ? entryIndexOf.get(entry.href) : entries.push(entry) - 1;
    }

    const slots = sources.map((slot, index) => ({
      slot,
      img: slot.querySelector("img"),
      link: slot.querySelector(".item"),
      entryIndex: index,
      near: false,
      onscreen: true,
    }));
    const count = entries.length - (current && currentIndex >= sources.length ? 1 : 0);
    const railLength = () => slots.length;

    let x = 0;
    let velocity = 0;
    let step = 0;
    let itemWidth = 0;
    let padding = 0;
    let cycle = 0;
    let viewWidth = 0;
    let drag = null;
    let glide = null;
    let holdUntil = 0;
    let frameId = 0;
    let lastTime = 0;
    let suppressClickUntil = 0;
    let paused = false;
    let keyboardIndex = null;

    function render() {
      for (const item of slots) {
        const left = mod(item.index * step - x + 2 * step, cycle) - 2 * step + padding;
        const near = left < viewWidth + step && left + itemWidth > -step;
        const onscreen = left < viewWidth && left + itemWidth > 0;
        if (near) item.slot.style.transform = `translate3d(${left}px, 0, 0)`;
        if (near !== item.near) {
          item.near = near;
          item.slot.classList.toggle("is-visible", near);
          if (near) item.img.decode().catch(() => {});
          else item.slot.style.transform = "";
        }
        if (onscreen === item.onscreen) continue;
        item.onscreen = onscreen;
        item.slot.inert = !onscreen || item.clone;
      }
    }

    function schedule() {
      if (frameId || paused) return;
      lastTime = 0;
      frameId = requestAnimationFrame(frame);
    }

    function frame(now) {
      frameId = 0;
      if (paused || !cycle) return;
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
      lastTime = now;

      if (glide) {
        const t = Math.min((now - glide.start) / glide.duration, 1);
        const eased = 1 - (1 - t) ** 5;
        x += (eased - glide.done) * glide.distance;
        glide.done = eased;
        if (t === 1) glide = null;
      } else if (!drag) {
        if (Math.abs(velocity) >= 2) {
          x += velocity * dt;
          velocity *= Math.exp(-FRICTION * dt);
        } else {
          velocity = 0;
        }
        if (now >= holdUntil && !reducedMotion.matches) x += DRIFT_SPEED * dt;
      }

      x = mod(x, cycle);
      render();
      if (drag || glide || velocity || !reducedMotion.matches) frameId = requestAnimationFrame(frame);
    }

    // Repeat the slides until the ring is longer than the screen.
    function fill() {
      const needed = Math.ceil((viewWidth + 4 * step) / step);
      let guard = 0;
      while (slots.length < needed && guard < 200) {
        guard += 1;
        const original = slots[slots.length % sources.length];
        const slot = original.slot.cloneNode(true);
        slot.querySelector("template")?.remove();
        slot.removeAttribute("id");
        slot.setAttribute("aria-hidden", "true");
        slot.querySelector(".item")?.setAttribute("tabindex", "-1");
        list.append(slot);
        slots.push({
          slot,
          img: slot.querySelector("img"),
          link: slot.querySelector(".item"),
          entryIndex: original.entryIndex,
          clone: true,
          near: false,
          onscreen: true,
        });
      }
      // Keep the ring a whole number of repeats so entries line up when it wraps.
      while (slots.length % sources.length !== 0 && guard < 400) {
        guard += 1;
        const original = slots[slots.length % sources.length];
        const slot = original.slot.cloneNode(true);
        slot.querySelector("template")?.remove();
        slot.setAttribute("aria-hidden", "true");
        list.append(slot);
        slots.push({ slot, img: slot.querySelector("img"), link: slot.querySelector(".item"), entryIndex: original.entryIndex, clone: true, near: false, onscreen: true });
      }
      slots.forEach((item, index) => { item.index = index; });
    }

    function measure() {
      const styles = getComputedStyle(list);
      const centerIndex = step ? (x + viewWidth / 2 - padding - itemWidth / 2) / step : null;
      itemWidth = sources[0].offsetWidth;
      step = itemWidth + (parseFloat(styles.columnGap) || 0);
      padding = parseFloat(styles.paddingLeft) || 0;
      viewWidth = viewport.clientWidth;
      if (!step) return;
      fill();
      cycle = step * railLength();
      if (centerIndex !== null) x = centerOffset(centerIndex);
      render();
      schedule();
    }

    function centerOffset(index) {
      return index * step + padding + itemWidth / 2 - viewWidth / 2;
    }

    // The slot showing an entry that is closest to being on screen.
    function slotFor(entryIndex) {
      let best = null;
      let bestFraction = -1;
      for (const item of slots) {
        if (item.entryIndex !== entryIndex) continue;
        const fraction = visibleFraction(item);
        if (fraction > bestFraction) {
          best = item;
          bestFraction = fraction;
        }
      }
      return best;
    }

    function visibleFraction(item) {
      const left = mod(item.index * step - x + 2 * step, cycle) - 2 * step + padding;
      const overlap = Math.min(left + itemWidth, viewWidth) - Math.max(left, 0);
      return Math.max(overlap, 0) / itemWidth;
    }

    function glideToSlot(item) {
      const distance = mod(centerOffset(item.index) - x + cycle / 2, cycle) - cycle / 2;
      velocity = 0;
      holdUntil = 0;
      if (reducedMotion.matches || Math.abs(distance) < 1) {
        glide = null;
        x += distance;
      } else {
        glide = { start: performance.now(), duration: Math.min(600, Math.max(260, Math.abs(distance) * 0.45)), distance, done: 0 };
      }
      schedule();
    }

    function nearestSlot() {
      const index = mod(Math.round((x + viewWidth / 2 - padding - itemWidth / 2) / step), slots.length);
      return slots[index];
    }

    function pointerDown(event) {
      if (paused || viewerActive() || event.button !== 0 || !cycle) return;
      keyboardIndex = null;
      viewport.classList.remove("is-keyboard-navigating");
      glide = null;
      velocity = 0;
      drag = { id: event.pointerId, startX: event.clientX, lastX: event.clientX, moved: false, samples: [{ x: event.clientX, time: event.timeStamp }] };
      viewport.classList.add("is-dragging");
      viewport.addEventListener("pointermove", pointerMove);
      viewport.addEventListener("pointerup", pointerEnd);
      viewport.addEventListener("pointercancel", pointerEnd);
      viewport.addEventListener("lostpointercapture", pointerEnd);
      event.target.setPointerCapture?.(event.pointerId);
      if (event.target.closest(".item")) event.preventDefault();
      schedule();
    }

    function pointerMove(event) {
      if (!drag || event.pointerId !== drag.id) return;
      x -= event.clientX - drag.lastX;
      drag.lastX = event.clientX;
      if (Math.abs(event.clientX - drag.startX) > 5) drag.moved = true;
      drag.samples.push({ x: event.clientX, time: event.timeStamp });
      while (drag.samples.length > 2 && event.timeStamp - drag.samples[0].time > 100) drag.samples.shift();
      schedule();
    }

    function pointerEnd(event) {
      if (!drag || event.pointerId !== drag.id) return;
      const gesture = drag;
      drag = null;
      viewport.classList.remove("is-dragging");
      viewport.removeEventListener("pointermove", pointerMove);
      viewport.removeEventListener("pointerup", pointerEnd);
      viewport.removeEventListener("pointercancel", pointerEnd);
      viewport.removeEventListener("lostpointercapture", pointerEnd);
      if (gesture.moved) suppressClickUntil = performance.now() + 350;
      velocity = 0;
      if (gesture.moved && event.type === "pointerup" && !reducedMotion.matches) {
        const first = gesture.samples[0];
        const last = gesture.samples.at(-1);
        const seconds = Math.max((last.time - first.time) / 1000, 0.001);
        const still = Math.max((event.timeStamp - last.time) / 1000, 0);
        const swipe = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, (last.x - first.x) / seconds));
        velocity = -swipe * Math.exp(-FRICTION * still);
      }
      schedule();
    }

    viewport.addEventListener("pointerdown", pointerDown);
    viewport.addEventListener("wheel", (event) => {
      if (paused || viewerActive() || drag || !cycle) return;
      // A scroll that began in the viewer (and its trackpad momentum) must not move the rail.
      if (performance.now() < wheelLockUntil) {
        wheelLockUntil = performance.now() + WHEEL_GAP;
        event.preventDefault();
        return;
      }
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewWidth : 1;
      const deltaX = event.deltaX * unit;
      const deltaY = event.deltaY * unit;
      const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
      if (!delta) return;
      event.preventDefault();
      glide = null;
      velocity = 0;
      x += delta;
      holdUntil = performance.now() + 180;
      schedule();
    }, { passive: false });

    viewport.addEventListener("click", (event) => {
      const link = event.target.closest(".item");
      if (!link) return;
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClickUntil = 0;
        return;
      }
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      const item = slots.find((candidate) => candidate.link === link);
      if (item) openFromPage(item.entryIndex);
    }, true);

    reducedMotion.addEventListener("change", () => {
      if (reducedMotion.matches) {
        glide = null;
        velocity = 0;
      }
      schedule();
    });

    fadeImagesIn(sources.map((slot) => slot.querySelector("img")));

    const rail = {
      wrap: true,
      entries: () => entries,
      sourceImage: (index) => (slotFor(index)?.img || null),
      hideSource(index, hidden) {
        const item = slotFor(index);
        item?.link.classList.toggle("is-zoomed", hidden);
        if (!hidden) for (const other of slots) other.link.classList.remove("is-zoomed");
      },
      pause() {
        paused = true;
        glide = null;
        velocity = 0;
      },
      resume() {
        paused = false;
        schedule();
      },
      settle(index) {
        // Bring the entry's slide in only if it is mostly off screen.
        const item = slotFor(index);
        if (item && visibleFraction(item) < 0.5) {
          x = centerOffset(item.index);
          render();
        }
      },
      keydown(event) {
        if (event.key === "Tab") {
          keyboardIndex = null;
          viewport.classList.remove("is-keyboard-navigating");
          return;
        }
        if (paused || drag || event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
        if (keyboardIndex !== null && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          openFromPage(slots[keyboardIndex].entryIndex);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const focused = event.target.closest?.(".item");
        const focusedSlot = focused ? slots.find((candidate) => candidate.link === focused) : null;
        const base = keyboardIndex ?? (focusedSlot ? focusedSlot.index : nearestSlot().index);
        const next = mod(base + (event.key === "ArrowRight" ? 1 : -1), slots.length);
        event.preventDefault();
        keyboardIndex = next;
        viewport.classList.add("is-keyboard-navigating");
        glideToSlot(slots[next]);
      },
    };

    measure();
    new ResizeObserver(measure).observe(viewport);

    rail.currentIndex = currentIndex >= 0 ? currentIndex : null;
    return rail;
  }

  // A grid of small images that loads more as you scroll.
  function createGrid() {
    const list = document.querySelector("[data-grid]");
    if (!list) return null;
    let more = document.querySelector("a.more[rel='next']");
    let loading = false;

    const links = () => [...list.querySelectorAll("a.cell:not([hidden])")];
    let cache = [];
    const refresh = () => {
      cache = links().map(readEntry);
    };
    refresh();

    async function loadMore() {
      if (loading || !more) return;
      loading = true;
      const pagination = more.closest(".pagination");
      pagination?.classList.add("is-loading-more");
      try {
        const response = await fetch(more.href, { credentials: "same-origin" });
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        const added = [...doc.querySelectorAll("[data-grid] a.cell")];
        for (const cell of added) list.append(document.adoptNode(cell));
        const next = doc.querySelector("a.more[rel='next']");
        if (next) more.href = next.href;
        else {
          more.closest(".pagination")?.remove();
          more = null;
        }
        refresh();
        observeSentinel();
      } catch (error) {
        pagination?.classList.remove("is-loading-more");
      }
      pagination?.classList.remove("is-loading-more");
      loading = false;
    }

    let observer = null;
    function observeSentinel() {
      observer?.disconnect();
      if (!more) return;
      observer = new IntersectionObserver((records) => {
        if (records.some((record) => record.isIntersecting)) loadMore();
      }, { rootMargin: "600px 0px" });
      observer.observe(more);
    }
    observeSentinel();

    list.addEventListener("click", (event) => {
      const link = event.target.closest("a.cell");
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const index = cache.findIndex((entry) => entry.link === link);
      if (index < 0) return;
      event.preventDefault();
      openFromPage(index);
    });

    return {
      wrap: false,
      entries: () => cache,
      sourceImage: (index) => cache[index]?.link.querySelector("img") || null,
      hideSource(index, hidden) {
        cache[index]?.link.classList.toggle("is-zoomed", hidden);
        if (!hidden) for (const entry of cache) entry.link.classList.remove("is-zoomed");
      },
      pause() {},
      resume() {},
      hasMore: () => Boolean(more),
      loadMore,
      settle(index) {
        const link = cache[index]?.link;
        if (!link) return;
        const rect = link.getBoundingClientRect();
        const visible = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
        if (visible < rect.height * 0.5) link.scrollIntoView({ block: "center", behavior: "instant" });
      },
    };
  }

  // ---- Start up ----

  controller = view === "home" || view === "entry" ? createRail() : createGrid();

  if (view === "entry") {
    // The entry's own page: the viewer starts open, and closing returns to the rail.
    if (!controller) {
      // No rail to return to (the entry has no image); keep the plain page.
      return;
    }
    const index = controller.currentIndex ?? controller.entries().findIndex((entry) => entry.href === location.pathname);
    if (index >= 0) {
      history.replaceState({ keynote: "open", pushed: false }, "", location.href);
      void open(index, { animate: false });
    }
  }
})();
