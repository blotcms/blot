{{{app_js}}}
// Infinite scroll on tag pages: as the end of the list comes near, the next page is
// fetched and its pictures added to the list, and the page links (there for readers
// without script) are hidden. The viewer is told about each picture added.
(function () {
  var navigation = document.querySelector("[data-pagination]");
  var list = document.querySelector("[data-grid]");
  if (!navigation || !list || !("IntersectionObserver" in window)) return;

  var base = navigation.getAttribute("data-base") || "";
  var next = parseInt(navigation.getAttribute("data-current"), 10) + 1;
  var total = parseInt(navigation.getAttribute("data-total"), 10);
  navigation.hidden = true;
  if (!(next <= total)) return;

  var sentinel = document.createElement("div");
  sentinel.setAttribute("aria-hidden", "true");
  list.after(sentinel);

  var loading = false;
  // Load when the end of the list is near, or already scrolled past (a jump to the
  // foot of the page, past every tag below the list).
  var observer = new IntersectionObserver(
    function (records) {
      var due = records.some(function (record) {
        return record.isIntersecting || record.boundingClientRect.top < 0;
      });
      if (due) load();
    },
    { rootMargin: "0px 0px 1500px 0px" }
  );
  observer.observe(sentinel);

  function finish() {
    observer.disconnect();
    sentinel.remove();
  }

  function load() {
    if (loading) return;
    if (next > total) return finish();
    loading = true;

    fetch(base + "/page/" + next)
      .then(function (response) {
        if (!response.ok) throw new Error("Page " + next + " answered " + response.status);
        return response.text();
      })
      .then(function (html) {
        var page = new DOMParser().parseFromString(html, "text/html");
        var items = page.querySelectorAll("[data-grid] > [data-entry]");
        var links = [];
        Array.prototype.forEach.call(items, function (item) {
          var adopted = document.adoptNode(item);
          list.appendChild(adopted);
          var link = adopted.querySelector("a[data-preview]");
          if (link) links.push(link);
        });
        list.dispatchEvent(new CustomEvent("entries-added", { detail: links }));
        next += 1;
        loading = false;
        if (!items.length || next > total) return finish();
        // Still in view (a short page, a tall window): keep going.
        var rect = sentinel.getBoundingClientRect();
        if (rect.top < innerHeight + 1500) load();
      })
      .catch(function () {
        // Show the page links again, so the rest can still be reached.
        finish();
        navigation.hidden = false;
      });
  }
})();

// Below a tag's page every tag has a row; leave out the one for this page.
(function () {
  var path = location.pathname.replace(/\/page\/\d+\/?$/, "").replace(/\/$/, "");
  Array.prototype.forEach.call(document.querySelectorAll("[data-tag-row]"), function (row) {
    if (decodeURI(row.getAttribute("data-tag-row")) === decodeURI(path)) row.remove();
  });
})();

// Mark the current page's link in the navigation for screen readers.
(function () {
  var active = document.querySelector(".primary-navigation a.active");
  if (active) active.setAttribute("aria-current", "page");
})();

// Image viewer, from the Keynote template, with every transition taken out: it opens,
// steps, zooms and closes at once.
(() => {
  const root = document.documentElement;


  const lightbox = document.querySelector(".lightbox");
  if (!lightbox) return;

  // The strip kept for the page's scrollbar, which the page is padded by while the viewer
  // is open. It can only be measured while the strip is there.
  const measureScrollbar = () => {
    if (root.classList.contains("is-viewing")) return;
    root.style.setProperty("--scrollbar-width", `${Math.max(0, innerWidth - root.getBoundingClientRect().width)}px`);
  };
  measureScrollbar();
  window.addEventListener("resize", measureScrollbar);

  const lightboxFrame = lightbox.querySelector(".lightbox-frame");
  const lightboxImage = lightbox.querySelector(".lightbox-image");
  const closeButton = lightbox.querySelector(".lightbox-close");
  const previousButton = lightbox.querySelector(".lightbox-previous");
  const nextButton = lightbox.querySelector(".lightbox-next");
  // The caption over the image, and its copy at the top of the details gutter.
  const captionTitles = lightbox.querySelectorAll(".lightbox-title");
  const captionIndexes = lightbox.querySelectorAll(".lightbox-index");
  // Everything in this viewer happens at once, so the animated paths always take the
  // branch Keynote keeps for reduced motion.
  const reducedMotion = { matches: true };

  const SWIPE_THRESHOLD = 56;

  const isLoaded = (image) => image.complete && image.naturalWidth > 0;
  const absolute = (url) => new URL(url, document.baseURI).href;

  // The address bar and the tab title follow the entry in the viewer.
  const siteName = document.querySelector('meta[property="og:site_name"]')?.content || document.title;
  const restingTitle = document.title;
  const titleFor = (entry) => (entry.title ? `${entry.title} - ${siteName}` : siteName);

  // ---- Entries: one per image link, read from the page ----

  // The post's HTML rides along escaped in an attribute rather than in a <template>, whose
  // images some browsers' preload scanners fetch: a page of full-size originals nobody sees.
  // It is parsed into an inert fragment only when wanted.
  function entryHTML(link) {
    const template = document.createElement("template");
    template.innerHTML = link.dataset.html || "";
    return template.content;
  }

  function readEntry(link) {
    const html = entryHTML(link);
    const original = html?.querySelector("img");
    const width = Number(link.dataset.width) || 1;
    const height = Number(link.dataset.height) || 1;
    return {
      link,
      href: new URL(link.getAttribute("href"), document.baseURI).pathname,
      title: link.dataset.title || "",
      alt: original?.getAttribute("alt") || link.dataset.title || "",
      date: link.dataset.date || "",
      preview: link.dataset.preview,
      full: original?.getAttribute("src") ? absolute(original.getAttribute("src")) : link.dataset.preview,
      width,
      height,
      fullWidth: Number(original?.getAttribute("width")) || width,
      // The post's place among all posts, counting up from the oldest.
      index: Number(link.dataset.index) || 0,
    };
  }

  // Remembers the last few full-size images decoded, so stepping back and forth is instant
  // without holding on to every image seen.
  const LOADED_LIMIT = 6;
  const loadedImages = new Map();
  function preloadImage(url) {
    let ready = loadedImages.get(url);
    if (ready) {
      loadedImages.delete(url);
    } else {
      const image = new Image();
      image.src = url;
      ready = image.decode().then(() => true, () => false);
    }
    loadedImages.set(url, ready);
    while (loadedImages.size > LOADED_LIMIT) loadedImages.delete(loadedImages.keys().next().value);
    return ready;
  }

  // ---- The viewer: one lightbox for whichever collection is on the page ----

  let controller = null; // the grid that supplies entries
  let activeIndex = 0;
  let imageToken = 0;
  let closedByScript = false;
  let leavingAddress = false; // a history move is under way
  let lightboxGesture = null;
  let suppressLightboxClickUntil = 0;

  const viewerActive = () => lightbox.open;

  function setActive(index) {
    resetZoom();
    const entries = controller.entries();
    activeIndex = Math.min(entries.length - 1, Math.max(0, index));
    const entry = entries[activeIndex];
    const token = ++imageToken;
    lightboxImage.style.setProperty("--image-ratio", entry.width / entry.height);
    lightboxImage.style.setProperty("--image-width", `${entry.fullWidth}px`);
    lightboxImage.width = entry.width;
    lightboxImage.height = entry.height;
    const source = controller.sourceImage(activeIndex);
    lightboxImage.src = source && isLoaded(source) && source.currentSrc ? source.currentSrc : entry.preview;
    lightboxImage.alt = entry.alt;
    previousButton.disabled = activeIndex === 0;
    nextButton.disabled = activeIndex === entries.length - 1;
    updateCaption();
    announce(entry);
    fillInfo(entry);

    upgradeChain(entry, token);
  }

  // The title, then its place among the posts as "5 of 52", worked out from each post's index and
  // the page's post count, so nothing extra has to load.
  const placeOf = () => controller.position(activeIndex);

  function updateCaption() {
    const entry = controller?.entries()[activeIndex];
    if (!entry || !captionTitles.length) return;
    for (const title of captionTitles) title.textContent = entry.title;
    const place = placeOf(entry);
    const index = place ? `${place.index} of ${place.total}` : "";
    for (const node of captionIndexes) node.textContent = index;
  }

  // Screen readers hear each image once, as "Title, 5 of 52", whether or not captions show.
  const announcer = lightbox.querySelector(".lightbox-announce");
  function announce(entry) {
    if (!announcer) return;
    const place = placeOf(entry);
    announcer.textContent = place ? `${entry.title}, ${place.index} of ${place.total}` : entry.title;
  }

  // ---- Post details: an Info button shows the post's text, then its date, tags and the photo's EXIF ----

  const infoButton = lightbox.querySelector(".lightbox-info-button");
  const infoPanel = lightbox.querySelector(".lightbox-info");
  const infoBody = infoPanel?.querySelector(".lightbox-info-body");
  const infoDetails = infoPanel?.querySelector(".lightbox-info-details");
  const infoDescription = infoPanel?.querySelector(".lightbox-info-description");
  const infoTags = infoPanel?.querySelector(".lightbox-info-tags");
  const infoLink = infoPanel?.querySelector(".lightbox-info-link");
  // One setting for every image, kept between visits: open, the details fill a gutter on the
  // right of each image in turn, until it's closed again.
  const INFO_KEY = "gallery:info";
  let infoWanted = false;
  try {
    infoWanted = localStorage.getItem(INFO_KEY) === "1";
  } catch {}

  function setInfo(open) {
    infoWanted = open;
    try {
      localStorage.setItem(INFO_KEY, open ? "1" : "0");
    } catch {}
    showInfo();
  }

  function showInfo() {
    if (!infoPanel) return;
    infoPanel.hidden = !infoWanted;
    lightbox.classList.toggle("has-info", infoWanted);
    root.classList.toggle("info-open", infoWanted);
    infoButton.setAttribute("aria-expanded", String(infoWanted));
  }

  function fillInfo(entry) {
    lightbox.scrollTop = 0; // each post starts with its image in full view
    if (!infoPanel) return;
    const body = entry.link.dataset.html ? entryHTML(entry.link) : null;
    // A bookmark's screenshot is on screen; its link becomes a button to the site.
    const bookmark = body?.querySelector("a.bookmark[href]");
    const bookmarkURL = bookmark ? safeURL(bookmark.getAttribute("href")) : null;
    if (bookmark) (bookmark.closest(".bookmark-container") || bookmark).remove();
    infoLink?.replaceChildren(...(bookmarkURL ? [bookmarkButton(bookmarkURL)] : []));
    // A folder post joins several files, each in its own section.
    const folderPost = body?.querySelector(".multi-file-post");
    const pictureCount = body ? body.querySelectorAll("img").length : 0;
    if (body) {
      for (const script of body.querySelectorAll("script")) script.remove();
      // The picture is already on screen, and so is the title: leave both out, with
      // anything that only held them. The picture's caption goes with it, and so does a
      // folder post's whole section for that file.
      const picture = bookmark ? null : body.querySelector("img");
      const caption = picture?.nextElementSibling?.matches(".caption") ? picture.nextElementSibling : null;
      const section = picture?.closest(".multi-file-entry");
      const heading = [...body.querySelectorAll("h1, h2, h3, p, .caption")].find((node) => node.textContent.trim() === entry.title);
      for (const node of [section || picture, caption, heading]) {
        let target = node;
        while (target?.parentNode && target.parentNode !== body && target.parentNode.childElementCount === 1 && !target.parentNode.textContent.trim()) target = target.parentNode;
        target?.remove();
      }
    }
    const hasText = Boolean(body && (body.textContent.trim() || body.querySelector("img, video, audio, iframe")));
    infoBody.replaceChildren(...(hasText ? [body] : []));
    const details = entry.link.querySelector("template.entry-details")?.content.cloneNode(true);
    // The photo's camera, lens and exposure, as a card.
    const exif = details?.querySelector(".entry-exif");
    const camera = exif?.querySelector(".entry-camera");
    if (camera) {
      // Most cameras repeat the make in the model ("Canon" and "Canon EOS R5"), so show it once.
      const make = camera.querySelector(".entry-camera-make");
      const model = camera.querySelector(".entry-camera-model");
      if (make && model && model.textContent.trim().toLowerCase().startsWith(make.textContent.trim().toLowerCase())) make.remove();
      if (!camera.textContent.trim()) camera.remove();
    }
    const exposure = exif?.querySelector(".entry-exposure");
    if (exposure && !exposure.querySelector("li")) exposure.remove();
    // A folder post of several photos merges their details, so the description and camera
    // card would belong to its last photo, not the one on screen: leave them out.
    const mixedPhotos = Boolean(folderPost) && pictureCount > 1;
    const hasExif = !mixedPhotos && Boolean(exif?.querySelector("p, li"));
    // The photo's own description reads as prose under the title.
    const description = mixedPhotos ? null : details?.querySelector(".entry-description");
    infoDescription?.replaceChildren(...(description ? [description] : []));
    // The tags go straight under the title, like the rail's caption.
    const tags = details?.querySelector(".entry-tags");
    infoTags?.replaceChildren(...(tags ? [tags] : []));
    // Then the date, and the camera card at the foot.
    const parts = [details?.querySelector(".entry-date"), hasExif ? exif : null].filter(Boolean);
    infoDetails.replaceChildren(...parts);
    const hasDetails = parts.length > 0 || Boolean(description) || Boolean(tags) || Boolean(bookmarkURL);
    // With the gutter open, the button stays to close it, even beside a post with no details.
    infoButton.hidden = !hasText && !hasDetails && !infoWanted;
    showInfo();
  }

  // Only a web address may become the bookmark's button.
  function safeURL(href) {
    try {
      const url = new URL(href, document.baseURI);
      return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch {
      return null;
    }
  }

  function bookmarkButton(url) {
    const link = document.createElement("a");
    link.className = "bookmark-button";
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `Visit ${url.hostname.replace(/^www\./, "")}`;
    link.insertAdjacentHTML("beforeend", '<svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9" /></svg>');
    return link;
  }

  infoButton?.addEventListener("click", () => setInfo(!infoWanted));

  // Sharpen in steps: the large thumbnail, then the original. Each is fetched and decoded first
  // and only swapped in once no transition is running, so nothing flickers or waits.
  async function upgradeChain(entry, token) {
    await lightboxImage.decode().catch(() => {});
    for (const url of [entry.preview, entry.full]) {
      if (token !== imageToken) return;
      if (!url || lightboxImage.currentSrc === absolute(url)) continue;
      const ready = await preloadImage(url);
      if (!ready || token !== imageToken) return;
      // The image is already decoded; decode synchronously so the swap never paints blank.
      lightboxImage.decoding = "sync";
      lightboxImage.addEventListener("load", () => { lightboxImage.decoding = "async"; }, { once: true });
      lightboxImage.src = url;
    }
  }

  function replaceAddress() {
    const entry = controller.entries()[activeIndex];
    history.replaceState({ ...history.state, gallery: "open" }, "", entry.href);
    document.title = titleFor(entry);
  }

  function step(direction) {
    const next = activeIndex + direction;
    if (next < 0 || next >= controller.entries().length) return;
    setActive(next);
    replaceAddress();
  }

  function startSwipe(event) {
    if (!lightbox.open || !event.isPrimary || event.button !== 0 || zoomed()) return;
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
    if (event.type === "pointercancel") return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    void step(deltaX < 0 ? 1 : -1);
  }

  // The viewer simply appears over the page.
  function open(index) {
    if (viewerActive() || !controller) return;
    resetZoom();
    setActive(index);
    lightbox.showModal();
    root.classList.add("is-viewing");
    lightboxFrame.focus({ preventScroll: true });
    lightbox.classList.add("is-revealed");
  }

  // Puts the page back as it was before the viewer opened. Safe to run more than once, so
  // it also tidies up after the browser closes the dialog itself.
  function cleanUpViewer() {
    root.classList.remove("is-viewing");
    lightbox.classList.remove("is-revealed");
    if (lightbox.open) {
      closedByScript = true;
      lightbox.close();
    }
    resetZoom();
    lightboxGesture = null;
    measureScrollbar();
  }

  function close() {
    if (!lightbox.open) return;
    // Leave the image that was open in view on the page.
    controller.settle(activeIndex);
    cleanUpViewer();
  }

  // ---- Address and history: opening pushes the entry's address, Back closes ----

  function openFromPage(index) {
    if (viewerActive()) return;
    const entry = controller.entries()[index];
    history.pushState({ gallery: "open" }, "", entry.href);
    document.title = titleFor(entry);
    open(index);
  }

  // Close button, Escape, a click outside the image and so on.
  function requestClose() {
    if (!lightbox.open) return;
    if (leaveEntryAddress()) return;
    close();
  }

  // Moves the address from the entry back to the page the viewer was opened on. Returns
  // true when that is a history move, whose popstate then closes the viewer.
  function leaveEntryAddress() {
    if (leavingAddress) return true;
    if (history.state?.gallery === "open") {
      leavingAddress = true;
      history.back();
      return true;
    }
    return false;
  }

  window.addEventListener("popstate", (event) => {
    leavingAddress = false;
    if (!controller) return;
    if (event.state?.gallery === "open") {
      const index = controller.entries().findIndex((entry) => entry.href === location.pathname);
      if (index >= 0) document.title = titleFor(controller.entries()[index]);
      if (index >= 0 && !viewerActive()) open(index);
      else if (index >= 0 && lightbox.open) setActive(index);
      return;
    }
    document.title = restingTitle;
    if (lightbox.open) close();
  });

  // ---- Zoom: wheel, pinch, buttons and keys enlarge the image up to 200% of its fitted size ----

  const MAX_ZOOM = 2;
  const ZOOM_STEP = 0.5;
  const WHEEL_ZOOM_RATE = Math.log(1.25) / 100; // a wheel notch, about 100px, zooms 25%
  const EXIT_PULL_LIMIT = 230; // wheel travel at 100% that closes the viewer
  const PAN_FRICTION = 4.2;
  const PAN_STIFFNESS = 420;
  const PAN_DAMPING = 40;
  const zoomOutButton = lightbox.querySelector(".zoom-out");
  const zoomInButton = lightbox.querySelector(".zoom-in");

  let zoomLevel = 1;
  let panX = 0;
  let panY = 0;
  let exitPull = 0;
  let exitTimer = 0;
  let animateTimer = 0;
  let pulledClosed = false;
  let wheelStamp = 0;
  let wheelTrackpad = false; // whether the current wheel gesture is a trackpad's two-finger scroll
  let calmUntil = 0;
  let panDrag = null;
  let panMotion = null;
  let panFrame = 0;
  let pinch = null;
  let dragX = 0; // a drag down to close moves the image with the finger
  let dragY = 0;
  let dragDown = null;
  let lastTap = null;
  let lastDoubleTapAt = 0;
  const pointers = new Map();

  const zoomed = () => zoomLevel > 1.001;
  const clampValue = (value, low, high) => Math.min(high, Math.max(low, value));
  const pullAmount = (distance) => (160 * distance) / (distance + 160);
  // How far a drag down to close has gone, from 0 to 1 at 60% of the screen's height.
  const dragProgress = () => (dragY > 0 ? Math.min(1, dragY / (lightbox.clientHeight * 0.6)) : 0);

  // Where the image's centre sits on screen with no zoom or pan applied.
  function baseCenter() {
    return {
      x: lightboxImage.offsetLeft + lightboxImage.offsetWidth / 2,
      y: lightboxImage.offsetTop + lightboxImage.offsetHeight / 2,
    };
  }

  // The part of the screen the image has: all of it, less the details gutter while that's
  // open, down the right or, on narrow screens, along the bottom.
  function stageSize() {
    let width = lightbox.clientWidth;
    let height = lightbox.clientHeight;
    if (infoPanel && !infoPanel.hidden) {
      const panel = infoPanel.getBoundingClientRect();
      if (panel.top > 1) height = Math.min(height, panel.top);
      else width = Math.min(width, panel.left);
    }
    return { width, height };
  }

  // How far the zoomed image may be moved: its edges stay on or beyond the stage's edges.
  function panBounds(level = zoomLevel) {
    const center = baseCenter();
    const stage = stageSize();
    const axis = (middle, size, view) => {
      const low = view - middle - size / 2;
      const high = size / 2 - middle;
      return low > high ? [view / 2 - middle, view / 2 - middle] : [low, high];
    };
    const [lowX, highX] = axis(center.x, lightboxImage.offsetWidth * level, stage.width);
    const [lowY, highY] = axis(center.y, lightboxImage.offsetHeight * level, stage.height);
    return { lowX, highX, lowY, highY };
  }

  function renderZoom() {
    const pullScale = reducedMotion.matches ? 1 : 1 - pullAmount(exitPull) / 500;
    const drag = dragProgress();
    const dragScale = 1 - drag * 0.3;
    const moved = zoomed() || panX || panY || dragX || dragY || pullScale !== 1;
    lightboxImage.style.transform = moved ? `translate3d(${panX + dragX}px, ${panY + dragY}px, 0) scale(${zoomLevel * pullScale * dragScale})` : "";
    lightbox.style.setProperty("--drag", drag.toFixed(3));
    // Zoomed in, the image has the whole screen, so the details scrolled up out of the way come back.
    if (zoomed() && lightbox.scrollTop) lightbox.scrollTop = 0;
    lightbox.classList.toggle("is-zoomed", zoomed());
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
    pulledClosed = false;
    dragDown = null;
    dragX = 0;
    dragY = 0;
    lightbox.classList.remove("is-dragging-down");
    renderZoom();
  }

  const screenCenter = () => {
    const stage = stageSize();
    return { x: stage.width / 2, y: stage.height / 2 };
  };

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
    if (event.target.closest?.(".lightbox-info")) return; // the post text scrolls
    event.preventDefault();
    if (pulledClosed) return;
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
    // A trackpad's two-finger scroll and a mouse wheel send the same events. Within one
    // gesture, any sideways movement, or a step that isn't a multiple of a wheel notch's
    // 120, gives the trackpad away.
    if (now - wheelStamp > 200) {
      wheelTrackpad = false;
    }
    wheelStamp = now;
    if (!wheelTrackpad && event.deltaMode === 0) {
      const notch = event.wheelDeltaY;
      wheelTrackpad = event.deltaX !== 0 || (Boolean(notch) && notch % 120 !== 0);
    }
    // Zoomed in, the trackpad pans the image, as it would scroll a page.
    if (wheelTrackpad && zoomed()) {
      stopPan();
      const bounds = panBounds();
      panX = clampValue(panX - deltaX, bounds.lowX, bounds.highX);
      panY = clampValue(panY - deltaY, bounds.lowY, bounds.highY);
      renderZoom();
      return;
    }
    if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
    if (deltaY < 0 && !zoomed()) {
      if (now > calmUntil) pullToClose(-deltaY);
      return;
    }
    // The wheel zooms continuously: a mouse's notches glide into each other, a trackpad's
    // small steps follow the fingers.
    setZoom(zoomLevel * Math.exp(deltaY * WHEEL_ZOOM_RATE), pivot, { animate: !wheelTrackpad });
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
      onImage: event.target === lightboxImage,
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
    // The capture sends the click to the viewer itself, which would read it as a click on the
    // backdrop and close: a press on the image, or a drag, isn't one.
    if (gesture.moved || gesture.onImage) suppressLightboxClickUntil = performance.now() + 350;
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
    if (event.target.closest("button, .zoom-controls, .lightbox-info")) return;
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
    if (event.type !== "pointerup" || event.pointerType === "mouse") return;
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

  // On touch screens, dragging the image down closes the viewer, as in a photo app: the image
  // follows the finger and shrinks, the page shows through, and letting go far enough or with
  // a flick closes it; otherwise it springs back. With the details open on a phone the viewer
  // scrolls, so the drag only takes over when it is already at the top.
  const DRAG_CLOSE_DISTANCE = 110;
  const DRAG_CLOSE_SPEED = 0.6; // px per ms

  function springBackDrag() {
    dragDown = null;
    if (!dragX && !dragY) return;
    dragX = 0;
    dragY = 0;
    animateZoom();
    lightbox.classList.remove("is-dragging-down");
    renderZoom();
  }

  lightbox.addEventListener(
    "touchstart",
    (event) => {
      dragDown = null;
      if (event.touches.length !== 1 || zoomed() || pulledClosed) return;
      if (event.target.closest("button, a, .zoom-controls, .lightbox-info")) return;
      const touch = event.touches[0];
      dragDown = { startX: touch.clientX, startY: touch.clientY, active: false, samples: [] };
    },
    { passive: true }
  );

  lightbox.addEventListener(
    "touchmove",
    (event) => {
      if (!dragDown) return;
      if (event.touches.length !== 1 || zoomed()) {
        springBackDrag();
        return;
      }
      const touch = event.touches[0];
      const deltaX = touch.clientX - dragDown.startX;
      const deltaY = touch.clientY - dragDown.startY;
      if (!dragDown.active) {
        if (Math.hypot(deltaX, deltaY) < 8) return;
        // Mostly downwards, with nothing above to scroll back to: a drag to close.
        if (deltaY <= 0 || Math.abs(deltaY) < Math.abs(deltaX) * 1.2 || lightbox.scrollTop > 0) {
          dragDown = null;
          return;
        }
        dragDown.active = true;
        lightboxGesture = null; // not a swipe to the next image
        suppressLightboxClickUntil = Number.POSITIVE_INFINITY;
        lightbox.classList.add("is-dragging-down");
      }
      event.preventDefault();
      dragX = deltaX;
      dragY = deltaY;
      dragDown.samples.push({ y: touch.clientY, time: event.timeStamp });
      while (dragDown.samples.length > 2 && event.timeStamp - dragDown.samples[0].time > 100) dragDown.samples.shift();
      renderZoom();
    },
    { passive: false }
  );

  const endDragDown = (event) => {
    if (!dragDown) return;
    const gesture = dragDown;
    if (!gesture.active) {
      dragDown = null;
      return;
    }
    suppressLightboxClickUntil = performance.now() + 350;
    const first = gesture.samples[0];
    const last = gesture.samples[gesture.samples.length - 1];
    const speed = first && last && last.time > first.time ? (last.y - first.y) / (last.time - first.time) : 0;
    if (event.type === "touchend" && (dragY > DRAG_CLOSE_DISTANCE || (speed > DRAG_CLOSE_SPEED && dragY > 30))) {
      dragDown = null;
      pulledClosed = true;
      void requestClose(); // closes from where the finger left the image
      return;
    }
    springBackDrag();
  };
  lightbox.addEventListener("touchend", endDragDown);
  lightbox.addEventListener("touchcancel", endDragDown);

  // With the details open, a click on the image zooms in on the place clicked. The swipe
  // captures the pointer on the frame, so the click arrives there: check it hit the image.
  let clickZoomAt = 0;
  const overImage = (event) => {
    const box = lightboxImage.getBoundingClientRect();
    return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  };
  lightboxFrame.addEventListener("click", (event) => {
    if (!lightbox.classList.contains("has-info") || zoomed() || !overImage(event)) return;
    if (event.detail > 1 || performance.now() < suppressLightboxClickUntil) return;
    clickZoomAt = performance.now();
    setZoom(MAX_ZOOM, { x: event.clientX, y: event.clientY });
  });

  // Pointer capture sends the double-click to the frame or the viewer, so check it hit the image.
  lightbox.addEventListener("dblclick", (event) => {
    if (!overImage(event) || event.target.closest("button, .zoom-controls, .lightbox-info")) return;
    // A touch double-tap has already been handled from its pointer events, and the
    // click before this one may already have zoomed in.
    if (performance.now() - lastDoubleTapAt < 600 || performance.now() - clickZoomAt < 600) return;
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

  // While zoomed in, the arrow keys move around the image instead of stepping to the next one.
  const PAN_KEYS = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  function panKey(event) {
    const direction = PAN_KEYS[event.key];
    if (!zoomed() || !direction) return false;
    event.preventDefault();
    stopPan();
    const bounds = panBounds();
    panX = clampValue(panX + direction[0] * lightbox.clientWidth * 0.2, bounds.lowX, bounds.highX);
    panY = clampValue(panY + direction[1] * lightbox.clientHeight * 0.2, bounds.lowY, bounds.highY);
    animateZoom();
    renderZoom();
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
    const byScript = closedByScript;
    closedByScript = false;
    if (lightbox.open) return; // opened again since
    cleanUpViewer();
    // The browser closed the dialog itself (it can ignore the cancel handler, for example
    // on Escape before the page has had a click): put the address back as a close would.
    if (!byScript && history.state?.gallery === "open") leaveEntryAddress();
  });

  window.addEventListener("keydown", (event) => {
    if (lightbox.open) {
      if (zoomKey(event)) return;
      // Escape closes (through the dialog's cancel event). Modified arrows are the browser's,
      // for example Alt+Left for Back.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (panKey(event)) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        void step(event.key === "ArrowRight" ? 1 : -1);
      }
    }
  });

  // ---- The grid: the catalog's images open the viewer, one page at a time ----

  function createGrid() {
    const list = document.querySelector("[data-grid]");
    if (!list) return null;

    // Each post is a card in the grid or a picture in the archives, marked data-entry. Posts
    // without an image link to their page; only images open the viewer.
    const cache = [...list.querySelectorAll("[data-entry] a[data-preview]")].map(readEntry);
    // Pictures added by infinite scroll join the end of the viewer's list.
    list.addEventListener("entries-added", (event) => {
      for (const link of event.detail) cache.push(readEntry(link));
    });
    const entryOf = (link) => link?.closest("[data-entry]");

    list.addEventListener("click", (event) => {
      const clicked = event.target.closest("a[href]");
      const row = entryOf(clicked);
      if (!row) return;
      const link = row.querySelector("a[data-preview]");
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const index = cache.findIndex((entry) => entry.link === link);
      if (index < 0) return;
      event.preventDefault();
      openFromPage(index);
    });

    return {
      entries: () => cache,
      sourceImage: (index) => entryOf(cache[index]?.link)?.querySelector("img") || null,
      // An image's place among all the listing's posts (those without images included).
      position(index) {
        const all = [...list.querySelectorAll("[data-entry]")];
        const at = all.indexOf(entryOf(cache[index]?.link));
        const total = Number(list.dataset.entries) || all.length;
        if (at < 0 || !total) return null;
        const offset = (Number(list.dataset.page) - 1 || 0) * (Number(list.dataset.pageSize) || 0);
        return { index: offset + at + 1, total };
      },
      settle(index) {
        const target = entryOf(cache[index]?.link)?.querySelector("img") || entryOf(cache[index]?.link);
        if (!target) return;
        const rect = target.getBoundingClientRect();
        const visible = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
        if (visible < rect.height * 0.5) target.scrollIntoView({ block: "center", behavior: "instant" });
      },
    };
  }

  controller = createGrid();
})();
