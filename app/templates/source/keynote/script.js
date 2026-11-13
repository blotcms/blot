{{{app_js}}}

(() => {
  const view = document.body.dataset.view;
  const root = document.documentElement;
  const mod = (value, length) => ((value % length) + length) % length;

  // ---- Keep the collection an entry was opened from so its arrows stay within it ----
  // The chronological next/previous hrefs are only ever replaced once we know better.

  const COLLECTION_KEY = "keynoteCollection";
  const DEPTH_KEY = "keynoteCollectionDepth";
  const cacheID = "{{cacheID}}";
  let closeURL = null;
  let closeDepth = 0;
  let followingCollection = false; // this entry page was reached through a listing's order
  let collectionPlace = null; // the entry's place in that listing, for the viewer's counter
  let entryLinksChanged = () => {};

  function pathOf(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin ? parsed.pathname.replace(/\/+$/, "") || "/" : null;
    } catch (error) {
      return null;
    }
  }

  // Close by walking back through the history entries pushed since the listing,
  // so the browser restores the listing exactly as it was left.
  function closeEntry() {
    if (closeDepth && closeDepth < history.length) history.go(-closeDepth);
    else location.href = closeURL || "/";
  }

  // Each entry page remembers how many history entries sit between it and the
  // listing. A page opened from the listing is one deep, and one reached with an
  // arrow is one deeper than the page it was left from. The depth is handed over
  // through sessionStorage, and kept in history.state so back, forward and
  // reload see the same value.
  function handOverDepth(link, depth) {
    try {
      sessionStorage.setItem(DEPTH_KEY, JSON.stringify({ path: pathOf(link.href), depth }));
    } catch (error) { /* storage can be unavailable */ }
  }

  function takeDepth() {
    const saved = history.state?.closeDepth;
    if (saved) return saved;
    try {
      const handed = JSON.parse(sessionStorage.getItem(DEPTH_KEY));
      sessionStorage.removeItem(DEPTH_KEY);
      return handed && handed.path === pathOf(location.href) ? handed.depth : 0;
    } catch (error) {
      return 0;
    }
  }

  function parseListing(doc, url) {
    const entries = [];
    for (const link of doc.querySelectorAll("a.collection-entry")) {
      const path = pathOf(link.href);
      if (path && !entries.includes(path)) entries.push(path);
    }
    if (!entries.length) return null;
    const pagination = (selector) => {
      const link = doc.querySelector(selector);
      return link?.getAttribute("href") ? link.href : null;
    };
    const next = pagination("a.collection-next");
    const previous = pagination("a.collection-previous");
    // Where the listing starts among all its posts, and how many there are, from the grid's
    // pagination. A listing with no pages (search) is the whole collection.
    const grid = doc.querySelector("[data-grid]");
    const pageNumber = Number(grid?.dataset.page) || 1;
    const pageSize = Number(grid?.dataset.pageSize) || 0;
    const total = Number(grid?.dataset.entries) || (!next && !previous ? entries.length : 0);
    return {
      url: url.split("#")[0],
      entries,
      next,
      previous,
      offset: pageSize ? (pageNumber - 1) * pageSize : 0,
      total,
    };
  }

  function readCollection() {
    try {
      return JSON.parse(sessionStorage.getItem(COLLECTION_KEY));
    } catch (error) {
      return null;
    }
  }

  function writeCollection(state) {
    try {
      sessionStorage.setItem(COLLECTION_KEY, JSON.stringify(state));
    } catch (error) { /* storage can be unavailable */ }
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a.entry-next, a.entry-previous");
    if (link && closeDepth) handOverDepth(link, closeDepth + 1);
  }, true);

  // Record the order shown by the listing before following one of its entries.
  document.addEventListener("click", (event) => {
    const entryLink = event.target.closest?.("a.collection-entry");
    if (!entryLink) return;
    handOverDepth(entryLink, 1);
    const listing = parseListing(document, location.href);
    if (listing) writeCollection({ cacheID, listings: [listing] });
  }, true);

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a.entry-close");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    closeEntry();
  });

  async function loadListing(url) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-cache" });
    if (!response.ok) throw new Error("Could not load collection page");
    return parseListing(new DOMParser().parseFromString(await response.text(), "text/html"), response.url);
  }

  // Follow a listing's pagination links, up to hops pages, until it has the entry.
  async function findEntry(url, path, direction, hops) {
    const listing = await loadListing(url);
    if (!listing || listing.entries.includes(path)) return listing;
    return hops && listing[direction] ? findEntry(listing[direction], path, direction, hops - 1) : null;
  }

  function initializeCollectionNavigation() {
    const state = readCollection();
    // Only trust the collection when arriving from elsewhere on this site.
    if (!state || !pathOf(document.referrer)) return;

    closeDepth = takeDepth();
    if (closeDepth) {
      history.replaceState({ ...history.state, closeDepth }, "");
      // Without script, or from elsewhere, the link goes home and says so; here it goes back.
      for (const link of document.querySelectorAll("a.entry-close")) link.textContent = "Back";
    }

    const path = pathOf(location.href);
    let page = -1;
    let index = -1;
    for (let n = 0; n < state.listings.length && index < 0; n += 1) {
      page = n;
      index = state.listings[n].entries.indexOf(path);
    }
    if (index < 0) return;

    // A publish changes cacheID and can push the entry onto a later page (or
    // pull it earlier), so find it in the current listing before using the order.
    if (state.cacheID !== cacheID) {
      const { url, previous } = state.listings[page];
      findEntry(url, path, "next", 3)
        .then((found) => found || (previous && findEntry(previous, path, "previous", 1)))
        .then((found) => {
          if (!found) return;
          const fresh = { cacheID, listings: [found] };
          writeCollection(fresh);
          followCollection(fresh, 0, found.entries.indexOf(path));
        }, () => {});
      return;
    }
    followCollection(state, page, index);
  }

  function followCollection(state, page, index) {
    followingCollection = true;
    const listing = state.listings[page];
    collectionPlace = listing.total ? { index: (listing.offset || 0) + index + 1, total: listing.total } : null;
    entryLinksChanged();
    closeURL = listing.url;
    for (const link of document.querySelectorAll("a.entry-close")) {
      link.href = closeURL;
      link.textContent = "Back";
    }

    const edge = (loaded, step) => loaded.entries[step > 0 ? 0 : loaded.entries.length - 1];

    // Resolves to the neighbour's path, null at the end of the collection, and
    // rejects when unsure (so the chronological link stays).
    async function neighbor(direction) {
      // entry.next is the newer entry, so it sits earlier in the listing; the
      // listing's own "next" page is the older one.
      const step = direction === "next" ? -1 : 1;
      const pageLink = listing[direction === "next" ? "previous" : "next"];
      if (listing.entries[index + step]) return listing.entries[index + step];

      const loaded = state.listings[page + step];
      if (loaded) return edge(loaded, step);
      // No link means the last page. Search is a single page of the model's
      // capped results, which are the whole collection.
      if (!pageLink) return null;

      const fetched = await loadListing(pageLink);
      if (!fetched) throw new Error("No entries on collection page");
      if (step > 0) state.listings.push(fetched);
      else state.listings.unshift(fetched);
      writeCollection(state);
      return edge(fetched, step);
    }

    for (const [selector, direction] of [["a.entry-previous", "previous"], ["a.entry-next", "next"]]) {
      const links = document.querySelectorAll(selector);
      if (!links.length) continue;
      neighbor(direction).then((target) => {
        for (const link of links) {
          if (target) {
            link.href = location.origin + target;
          } else {
            link.removeAttribute("href");
            link.setAttribute("aria-disabled", "true");
          }
        }
        entryLinksChanged();
      }, () => {});
    }
  }

  if (view === "entry") initializeCollectionNavigation();

  // Left is the newer entry and right the older one, as on the rail.
  function followEntryKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    const selector = { ArrowLeft: "a.entry-next", ArrowRight: "a.entry-previous" }[event.key];
    const link = selector && document.querySelector(selector);
    if (link?.href) link.click();
  }

  for (const link of document.querySelectorAll(view === "search" ? "#header .nav a.active" : "#header .nav a.active, .tag-navigation a.active")) {
    link.setAttribute("aria-current", "page");
  }
  if (view === "home") document.getElementById("title")?.setAttribute("aria-current", "page");

  // ---- Tag filters: a row that ends in a button opening the full list, remembered across pages ----

  const tagNavigation = document.querySelector(".tag-navigation");
  const tagToggle = tagNavigation?.querySelector(".tag-toggle");
  if (tagToggle) {
    const TAGS_KEY = "keynoteTagsExpanded";
    const tagList = tagNavigation.querySelector("ul");
    const toggleItem = tagToggle.closest("li");
    const toolbar = tagNavigation.closest(".list-toolbar");
    const searchForm = toolbar?.querySelector(".search-form");
    const pills = [...tagList.children].filter((item) => item !== toggleItem);
    const expanded = () => root.classList.contains("tags-expanded");
    const syncTags = () => {
      for (const item of pills) item.classList.remove("is-overflow");
      toggleItem.hidden = true;
      const gap = parseFloat(getComputedStyle(tagList).columnGap) || 0;
      const widths = pills.map((item) => item.offsetWidth);
      const total = widths.reduce((sum, width) => sum + width, 0) + gap * (pills.length - 1);
      // Squeeze the search box when the tags wouldn't fit beside it at its full width. Judged
      // against that full width either way, so the decision doesn't flip once it is made.
      if (searchForm) {
        const fullSearch = 12 * parseFloat(getComputedStyle(searchForm).fontSize);
        const fullRow = tagList.clientWidth + searchForm.offsetWidth - fullSearch;
        toolbar.classList.toggle("tags-long", total > fullRow);
      }
      const available = tagList.clientWidth;
      if (total > available) {
        toggleItem.hidden = false;
        if (!expanded()) {
          // Keep whole pills that fit before the button; hide the rest.
          const room = available - toggleItem.offsetWidth - gap;
          let used = 0;
          pills.forEach((item, index) => {
            const width = widths[index] + (index ? gap : 0);
            if (used + width > room) {
              item.classList.add("is-overflow");
              used = Infinity;
            } else {
              used += width;
            }
          });
        }
      }
      tagToggle.setAttribute("aria-expanded", String(expanded()));
    };
    tagToggle.addEventListener("click", () => {
      root.classList.toggle("tags-expanded");
      try {
        localStorage.setItem(TAGS_KEY, expanded() ? "1" : "0");
      } catch (error) { /* storage can be unavailable */ }
      syncTags();
    });
    new ResizeObserver(syncTags).observe(tagNavigation);
    syncTags();
  }

  const lightbox = document.querySelector(".lightbox");
  if (!lightbox) return;

  // The strip kept for the page's scrollbar: the root reports the full window width, the body doesn't.
  const measureScrollbar = () => root.style.setProperty("--scrollbar-width", `${Math.max(0, innerWidth - document.body.getBoundingClientRect().width)}px`);
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
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const SWIPE_THRESHOLD = 56;
  const WHEEL_GAP = 150; // ms of quiet that ends a wheel gesture
  const CONTEXT_KEY = "keynoteContext";

  const isLoaded = (image) => image.complete && image.naturalWidth > 0;
  const absolute = (url) => new URL(url, document.baseURI).href;

  // The address bar and the tab title follow the entry in the viewer.
  const siteName = document.querySelector('meta[property="og:site_name"]')?.content || document.title;
  let restingTitle = view === "entry" ? siteName : document.title;
  const titleFor = (entry) => (entry.title ? `${entry.title} - ${siteName}` : siteName);

  // ---- Entries: one per image link, read from the page ----

  function readEntry(link) {
    const html = link.querySelector("template.entry-html")?.content;
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

  let controller = null; // the rail or the grid that supplies entries
  let activeIndex = 0;
  let imageToken = 0;
  let opening = false;
  let closeAfterOpen = false;
  let closing = false;
  let closePending = false;
  let closedByScript = false;
  let leavingAddress = false; // a history move or navigation away is under way
  let stepping = false;
  let lightboxGesture = null;
  let suppressLightboxClickUntil = 0;
  let wheelLockUntil = 0;

  const lightboxBusy = () => opening || closing || closePending;
  const viewerActive = () => lightbox.open || lightboxBusy();

  // An entry from outside the rail (an older entry's own page) steps with its page links.
  const entryLink = (direction) => document.querySelector(direction > 0 ? "a.entry-previous" : "a.entry-next");

  // The viewer steps with the entry page's own links (rather than through the rail) for an
  // entry from outside the rail, and for an entry page reached through a listing, whose links
  // follow that listing's order. Once the viewer is reopened from the rail, the rail leads.
  const stepsByEntryLinks = (entry) =>
    Boolean(entry?.detached) || (followingCollection && view === "entry" && history.state?.keynote === "open" && !history.state.pushed);

  entryLinksChanged = () => {
    const entry = controller?.entries()[activeIndex];
    if (!lightbox.open || !stepsByEntryLinks(entry)) return;
    previousButton.disabled = !entryLink(-1)?.href;
    nextButton.disabled = !entryLink(1)?.href;
    updateCaption();
  };

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
    if (stepsByEntryLinks(entry)) {
      previousButton.disabled = !entryLink(-1)?.href;
      nextButton.disabled = !entryLink(1)?.href;
    } else {
      previousButton.disabled = !controller.wrap && activeIndex === 0;
      nextButton.disabled = !controller.wrap && activeIndex === entries.length - 1 && !controller.hasMore?.();
    }
    if (activeIndex >= entries.length - 4) controller.loadMore?.();
    controller.prefetch?.(activeIndex);
    updateCaption();
    announce(entry);
    fillInfo(entry);

    upgradeChain(entry, token);
  }

  // The title, then its place among the posts as 05/52, worked out from each post's index and
  // the page's post count, so nothing extra has to load.
  // Reached through a listing, the arrows follow it, and so does the counter.
  const placeOf = (entry) => (stepsByEntryLinks(entry) && collectionPlace ? collectionPlace : controller.position?.(activeIndex));

  function updateCaption() {
    const entry = controller?.entries()[activeIndex];
    if (!entry || !captionTitles.length) return;
    for (const title of captionTitles) title.textContent = entry.title;
    const place = placeOf(entry);
    // The index takes as many digits as the total: 3/4, 05/52, 005/120.
    const width = place ? String(place.total).length : 0;
    const index = place ? `${String(place.index).padStart(width, "0")}/${place.total}` : "";
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
  // One setting for every image, kept between visits: open, the details fill a gutter on the
  // right of each image in turn, until it's closed again.
  const INFO_KEY = "keynote:info";
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
    infoButton.setAttribute("aria-expanded", String(infoWanted));
  }

  function fillInfo(entry) {
    if (!infoPanel) return;
    const body = entry.link.querySelector("template.entry-html")?.content.cloneNode(true);
    if (body) {
      for (const script of body.querySelectorAll("script")) script.remove();
      // The picture is already on screen, and so is the title: leave both out, with
      // anything that only held them.
      const picture = body.querySelector("img");
      const heading = [...body.querySelectorAll("h1, h2, h3, p, .caption")].find((node) => node.textContent.trim() === entry.title);
      for (const node of [picture, heading]) {
        let target = node;
        while (target?.parentNode && target.parentNode !== body && target.parentNode.childElementCount === 1 && !target.parentNode.textContent.trim()) target = target.parentNode;
        target?.remove();
      }
    }
    const hasText = Boolean(body && (body.textContent.trim() || body.querySelector("img, video, audio, iframe")));
    infoBody.replaceChildren(...(hasText ? [body] : []));
    const details = entry.link.querySelector("template.entry-details")?.content.cloneNode(true);
    const list = details?.querySelector(".entry-details");
    for (const camera of list?.querySelectorAll(".entry-camera") || []) {
      // Most cameras repeat the make in the model ("Canon" and "Canon EOS R5"), so show it once.
      const make = camera.querySelector(".entry-camera-make");
      const model = camera.querySelector(".entry-camera-model");
      if (make && model && model.textContent.trim().toLowerCase().startsWith(make.textContent.trim().toLowerCase())) make.remove();
      if (!camera.querySelector("dd").textContent.trim()) camera.remove();
    }
    // The photo's own description reads as prose under the title, not as a row of the table.
    const description = details?.querySelector(".entry-description");
    infoDescription?.replaceChildren(...(description ? [description] : []));
    const hasDetails = Boolean(list?.querySelector("dt") || description);
    infoDetails.replaceChildren(...(hasDetails ? [list] : []));
    // With the gutter open, the button stays to close it, even beside a post with no details.
    infoButton.hidden = !hasText && !hasDetails && !infoWanted;
    showInfo();
  }

  infoButton?.addEventListener("click", () => setInfo(!infoWanted));

  // The rail inserted `count` entries at `at`; keep the viewer on the same entry.
  function entriesInserted(at, count, moved) {
    if (moved && activeIndex === moved.from) activeIndex = moved.to;
    else if (activeIndex >= at) activeIndex += count;
    if (lightbox.open) updateCaption();
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
    history.replaceState({ ...history.state, keynote: "open" }, "", entry.href);
    document.title = titleFor(entry);
  }

  async function step(direction) {
    if (lightboxBusy() || stepping) return;
    if (stepsByEntryLinks(controller.entries()[activeIndex])) {
      const link = entryLink(direction);
      if (link?.href) link.click();
      return;
    }
    stepping = true;
    try {
      // The rail loads the neighbouring page first when the step would cross into it.
      for (let guard = 0; guard < 50 && (await controller.ensure?.(activeIndex, direction)); guard += 1);
      if (!controller.wrap && activeIndex + direction >= controller.entries().length && controller.hasMore?.()) {
        await controller.loadMore();
      }
    } catch (error) {
      /* a page that fails to load leaves the step to the entries already here */
    } finally {
      stepping = false;
    }
    if (!lightbox.open || lightboxBusy()) return;
    const entries = controller.entries();
    let next = activeIndex + direction;
    if (!controller.wrap && (next < 0 || next >= entries.length)) return;
    if (controller.wrap) {
      next = mod(next, entries.length);
      if (entries[next].detached && entries.length > 1) next = mod(next + direction, entries.length);
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
    void step(deltaX < 0 ? 1 : -1);
  }

  function reveal() {
    opening = false;
    lightbox.classList.remove("is-opening");
    if (closeAfterOpen) {
      // The close was asked for during the opening zoom, and the address has already been
      // dealt with (Back, or requestClose), so only the viewer itself is left to close.
      closeAfterOpen = false;
      void close();
      return;
    }
    if (lightbox.open) lightbox.classList.add("is-revealed");
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

  // Puts the page back as it was before the viewer opened. Safe to run more than once, so
  // it also tidies up after the browser closes the dialog itself.
  function cleanUpViewer() {
    root.classList.remove("lightbox-transition-closing", "is-zooming", "is-leaving", "is-viewing", "is-deep-open");
    for (const image of document.querySelectorAll(".is-transitioning")) {
      image.classList.remove("is-transitioning");
      image.style.removeProperty("view-transition-name");
    }
    lightbox.classList.remove("is-closing", "is-opening", "is-revealed");
    if (lightbox.open) {
      closedByScript = true;
      lightbox.close();
    }
    resetZoom();
    controller?.hideSource(activeIndex, false);
    opening = false;
    closeAfterOpen = false;
    closing = false;
    closePending = false;
    lightboxGesture = null;
    controller?.resume();
  }

  async function close({ animate = true } = {}) {
    if (opening) {
      closeAfterOpen = true;
      return;
    }
    if (!lightbox.open || closePending) return;
    closePending = true;
    root.classList.remove("is-deep-open");
    // Bring the header back as the viewer starts to leave, not once it has gone.
    root.classList.add("is-leaving");
    // An image mostly still on screen zooms back to where it was; otherwise the page brings it in first.
    controller.settle(activeIndex);
    const source = animate ? controller.sourceImage(activeIndex) : null;
    await Promise.all([source, lightboxImage].filter((image) => image && isLoaded(image)).map((image) => image.decode().catch(() => {})));
    if (!lightbox.open) {
      cleanUpViewer();
      return;
    }

    const hide = () => {
      controller.hideSource(activeIndex, false);
      lightbox.classList.remove("is-revealed", "is-opening");
      lightbox.classList.add("is-closing");
    };

    if (!source || reducedMotion.matches || !document.startViewTransition) {
      hide();
      cleanUpViewer();
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
    transition.finished.then(cleanUpViewer, cleanUpViewer);
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
    document.title = titleFor(entry);
    void open(index);
  }

  // Close button, Escape, a click outside the image and so on.
  async function requestClose() {
    if (!lightbox.open && !opening) return;
    if (leaveEntryAddress()) return;
    await close();
  }

  // Moves the address from the entry back to where the viewer was opened from. Returns true
  // when that is another history entry or page, which then closes the viewer itself.
  function leaveEntryAddress() {
    if (leavingAddress) return true;
    if (history.state?.keynote === "open" && history.state.pushed) {
      leavingAddress = true;
      history.back(); // the popstate handler closes the viewer
      return true;
    }
    // Reached through a listing's links: walk back to the listing as it was left.
    if (closeDepth && closeDepth < history.length) {
      leavingAddress = true;
      history.go(-closeDepth);
      return true;
    }
    // Reached through a listing without history to walk back through (say, a new tab): load it.
    if (closeURL) {
      leavingAddress = true;
      window.location.href = closeURL;
      return true;
    }
    // Elsewhere the viewer was opened over the page without moving the address.
    if (view !== "entry") return false;
    // Opened directly (or after a reload): go back to the listing it came from, or to the rail.
    const target = directTarget();
    if (target.navigate) {
      leavingAddress = true;
      window.location.href = target.url;
      return true;
    }
    history.replaceState(null, "", target.url);
    document.title = restingTitle;
    return false;
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
    leavingAddress = false;
    if (!controller) return;
    const state = event.state;
    if (state?.keynote === "open") {
      const index = controller.entries().findIndex((entry) => entry.href === location.pathname);
      if (index >= 0) document.title = titleFor(controller.entries()[index]);
      if (index >= 0 && !viewerActive()) void open(index);
      else if (index >= 0 && lightbox.open) setActive(index);
      return;
    }
    document.title = restingTitle;
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
    const moved = zoomed() || panX || panY || pullScale !== 1;
    lightboxImage.style.transform = moved ? `translate3d(${panX}px, ${panY}px, 0) scale(${zoomLevel * pullScale})` : "";
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
    wheelTotal = 0;
    pulledClosed = false;
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
    if (event.target.closest("button, .zoom-controls, .lightbox-info") || lightboxBusy()) return;
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
    if (!byScript && history.state?.keynote === "open") leaveEntryAddress();
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
      return;
    }
    if (controller) controller.keydown?.(event);
    else if (view === "entry") followEntryKey(event);
  });

  // ---- Controllers ----

  function fadeImagesIn(images) {
    for (const img of images) {
      if (!img) continue;
      if (isLoaded(img)) img.classList.add("is-loaded");
      else img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
    }
  }

  // Rail images carry their sources in data attributes until their slide nears the screen.
  function loadImage(img) {
    if (!img?.dataset.src) return;
    if (img.dataset.srcset) img.srcset = img.dataset.srcset;
    img.src = img.dataset.src;
    delete img.dataset.src;
    delete img.dataset.srcset;
  }

  // A rail of slides that drifts, drags, and wraps round as a ring. It starts with one page
  // of entries and loads the pages on either side as they come near: older pages to the
  // right, and to the left the oldest pages, wrapping round from the newest. Once every page
  // is in, the ring holds the whole blog; with few images the set is repeated so it always
  // fills the screen.
  function createRail() {
    const viewport = document.querySelector(".rail-viewport");
    const list = viewport?.querySelector(".rail");
    if (!list) return null;
    const firstSlides = [...list.querySelectorAll(".slide")];
    const current = document.querySelector(".current-entry .item[data-preview]");
    // With no images on this page there may still be some on later ones, or the entry page's
    // own image: start empty and load pages until there are slides.
    if (!firstSlides.length && !current && !(Number(viewport.dataset.total) > 1)) return null;

    const DRIFT_SPEED = 8; // px per second
    const drift = {{#drift}}true{{/drift}}{{^drift}}false{{/drift}}; // the "drift" setting
    // No drift while the tab is hidden, so a background tab does no work at all.
    const drifting = () => drift && !reducedMotion.matches && !document.hidden;
    const FRICTION = 4.2;
    const MAX_VELOCITY = 1100;
    const RETRY_DELAY = 5000; // ms before a page that failed to load is tried again
    const EMPTY_PAGE_LIMIT = 5; // pages to look through for an image before giving up

    const startPage = Number(viewport.dataset.page) || 1;
    let total = Number(viewport.dataset.total) || startPage;
    let forwardPage = startPage; // the last page loaded to the right of the start
    let backwardPage = startPage; // the last page loaded to the left of the start
    let pagesLoaded = 1;
    let loadingPage = null;
    let retryAt = 0;
    const complete = () => pagesLoaded >= total;
    const totalEntries = Number(viewport.dataset.entries) || 0;
    const wrapPage = (page) => mod(page - 1, total) + 1;

    const makeSlot = (slot, clone = false, page = startPage) => ({
      slot,
      page,
      img: slot.querySelector(".item img"),
      link: slot.querySelector(".item"),
      entryIndex: 0,
      index: 0,
      clone,
      near: false,
      onscreen: null,
    });

    // Slots are in ring order. Until every page is in there are no clones, so slot i shows
    // entry i. `seam` is the slot where the pages to the right of the start meet those to
    // the left; new pages go in there.
    const slots = firstSlides.map((slot) => makeSlot(slot));
    const entries = slots.map((item) => readEntry(item.link));
    let seam = slots.length;
    const searching = () => !slots.length && !complete() && pagesLoaded < EMPTY_PAGE_LIMIT;
    const showLoading = () => viewport.classList.toggle("is-loading", searching());

    // The entry page also names the entry being shown, which may not be on the rail yet.
    let extra = null;
    let currentIndex = -1;
    if (current) {
      const entry = readEntry(current);
      currentIndex = entries.findIndex((candidate) => candidate.href === entry.href);
      if (currentIndex < 0) {
        extra = { ...entry, detached: true };
        currentIndex = entries.push(extra) - 1;
      }
    }

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

    function renumber() {
      let original = 0;
      slots.forEach((item, index) => {
        item.index = index;
        if (!item.clone) item.entryIndex = original++;
      });
    }
    renumber();

    // Where a slot's left edge sits on screen.
    const slotLeft = (item) => mod(item.index * step - x + 2 * step, cycle) - 2 * step + padding;

    function render() {
      for (const item of slots) {
        const left = slotLeft(item);
        const near = left < viewWidth + step && left + itemWidth > -step;
        const onscreen = left < viewWidth && left + itemWidth > 0;
        if (near) item.slot.style.transform = `translate3d(${left}px, 0, 0)`;
        if (near !== item.near) {
          item.near = near;
          item.slot.classList.toggle("is-visible", near);
          if (near) {
            loadImage(item.img);
            item.img.decode().catch(() => {});
          } else {
            item.slot.style.transform = "";
          }
        }
        if (onscreen === item.onscreen) continue;
        item.onscreen = onscreen;
        item.slot.inert = !onscreen; // clones stay clickable; aria-hidden and tabindex keep them out of the tab order
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
        if (now >= holdUntil && drifting()) x += DRIFT_SPEED * dt;
      }

      x = mod(x, cycle);
      render();
      maybeLoad();
      if (drag || glide || velocity || drifting()) frameId = requestAnimationFrame(frame);
    }

    function cloneSlot(original) {
      const slot = original.slot.cloneNode(true);
      slot.querySelector("template")?.remove();
      slot.removeAttribute("id");
      slot.setAttribute("aria-hidden", "true");
      slot.classList.remove("is-visible");
      slot.style.removeProperty("transform");
      const link = slot.querySelector(".item");
      link?.setAttribute("tabindex", "-1");
      link?.classList.remove("is-zoomed");
      list.append(slot);
      const item = { ...makeSlot(slot, true, original.page), entryIndex: original.entryIndex };
      fadeImagesIn([item.img]);
      return item;
    }

    // Once every page is in, repeat the slides until the ring is longer than the screen,
    // keeping it a whole number of repeats so entries line up when it wraps.
    function fill() {
      if (!complete() || !step) return;
      const originals = slots.filter((item) => !item.clone);
      if (!originals.length) return;
      const needed = Math.ceil((viewWidth + 4 * step) / step);
      let guard = 0;
      while ((slots.length < needed || slots.length % originals.length !== 0) && guard < 400) {
        guard += 1;
        slots.push(cloneSlot(originals[slots.length % originals.length]));
      }
      renumber();
    }

    function measure() {
      const styles = getComputedStyle(list);
      const centerIndex = step ? (x + viewWidth / 2 - padding - itemWidth / 2) / step : null;
      itemWidth = slots[0]?.slot.offsetWidth ?? probeWidth();
      step = itemWidth + (parseFloat(styles.columnGap) || 0);
      padding = parseFloat(styles.paddingLeft) || 0;
      viewWidth = viewport.clientWidth;
      if (!step) return;
      fill();
      cycle = step * slots.length;
      if (centerIndex !== null) x = centerOffset(centerIndex);
      render();
      maybeLoad();
      schedule();
    }

    // An empty rail measures a stand-in slide.
    function probeWidth() {
      const probe = document.createElement("li");
      probe.className = "slide";
      probe.setAttribute("aria-hidden", "true");
      list.append(probe);
      const width = probe.offsetWidth;
      probe.remove();
      return width;
    }

    function centerOffset(index) {
      return index * step + padding + itemWidth / 2 - viewWidth / 2;
    }

    // ---- Pages either side of the start ----

    // Load the next page on whichever side the seam is near: within a screen and a half of
    // the middle of the view.
    function maybeLoad() {
      showLoading();
      if (complete() || loadingPage || performance.now() < retryAt) return;
      if (!slots.length) {
        if (searching()) void loadPage("forward");
        return;
      }
      if (!cycle) return;
      const reach = viewWidth * 1.5 + step * 2;
      const seamX = seam * step + padding - (step - itemWidth) / 2;
      const distance = mod(seamX - (x + viewWidth / 2) + cycle / 2, cycle) - cycle / 2;
      if (Math.abs(distance) < reach) void loadPage(distance >= 0 ? "forward" : "backward");
    }

    function loadPage(direction) {
      if (complete()) return Promise.resolve();
      if (loadingPage) return loadingPage;
      loadingPage = (async () => {
        const page = direction === "forward" ? wrapPage(forwardPage + 1) : wrapPage(backwardPage - 1);
        try {
          const response = await fetch(`/page/${page}`, { credentials: "same-origin" });
          if (!response.ok) throw new Error(`Could not load page ${page}`);
          const doc = new DOMParser().parseFromString(await response.text(), "text/html");
          total = Number(doc.querySelector(".rail-viewport")?.dataset.total) || total;
          if (complete()) return;
          if (direction === "forward") forwardPage = page;
          else backwardPage = page;
          pagesLoaded += 1;
          insertSlides([...doc.querySelectorAll(".rail .slide")], direction, page);
        } catch (error) {
          retryAt = performance.now() + RETRY_DELAY;
          // Try again then even if nothing moves the rail in the meantime.
          setTimeout(maybeLoad, RETRY_DELAY);
        }
      })().finally(() => {
        loadingPage = null;
        setTimeout(maybeLoad);
      });
      return loadingPage;
    }

    function insertSlides(elements, direction, page) {
      // A publish can move entries between pages, so skip any already on the rail.
      const known = new Set(entries.filter((entry) => !entry.detached).map((entry) => entry.href));
      const added = [];
      for (const element of elements) {
        const link = element.querySelector(".item");
        if (!link) continue;
        const href = new URL(link.getAttribute("href"), document.baseURI).pathname;
        if (known.has(href)) continue;
        known.add(href);
        // The fetched page was parsed without script, so its fallback images are real elements.
        for (const fallback of element.querySelectorAll("noscript")) fallback.remove();
        added.push(document.adoptNode(element));
      }

      if (!added.length) {
        fill();
        cycle = step * slots.length;
        render();
        return;
      }

      // Keep the slide nearest the middle of the screen where it is.
      const anchor = cycle ? nearestSlot() : null;
      const anchorLeft = anchor ? slotLeft(anchor) : 0;

      const at = seam;
      const before = slots[at]?.slot || null;
      const items = added.map((element) => {
        list.insertBefore(element, before);
        return makeSlot(element, false, page);
      });
      const newEntries = items.map((item) => readEntry(item.link));
      slots.splice(at, 0, ...items);

      // The entry page's own entry turned up on the rail: use its place there.
      let moved = null;
      if (extra) {
        const found = newEntries.findIndex((entry) => entry.href === extra.href);
        if (found >= 0) {
          moved = { from: entries.length - 1, to: at + found };
          entries.pop();
          extra = null;
        }
      }
      entries.splice(at, 0, ...newEntries);
      if (direction === "forward") seam += items.length;
      if (keyboardIndex !== null && keyboardIndex >= at) keyboardIndex += items.length;
      if (currentIndex >= 0) {
        currentIndex = moved && currentIndex === moved.from ? moved.to : currentIndex + (currentIndex >= at ? items.length : 0);
      }

      renumber();
      fadeImagesIn(items.map((item) => item.img));
      fill();
      cycle = step * slots.length;
      if (anchor) x = mod(anchor.index * step - (anchorLeft - padding), cycle);
      entriesInserted(at, items.length, moved);
      render();
      schedule();
    }

    // The slot showing an entry that is closest to being on screen.
    function slotFor(entryIndex) {
      let best = null;
      let bestFraction = -1;
      for (const item of slots) {
        if (item.entryIndex !== entryIndex || entries[entryIndex]?.detached) continue;
        const fraction = visibleFraction(item);
        if (fraction > bestFraction) {
          best = item;
          bestFraction = fraction;
        }
      }
      return best;
    }

    function visibleFraction(item) {
      const left = slotLeft(item);
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

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) return schedule();
      cancelAnimationFrame(frameId);
      frameId = 0;
    });

    // The first slides on screen load straight away, the very first ahead of everything else.
    slots.slice(0, 3).forEach((item, index) => {
      if (index === 0) item.img.fetchPriority = "high";
      loadImage(item.img);
    });
    fadeImagesIn(slots.map((item) => item.img));

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
      // Before the viewer steps from `index` across the seam, load the page that belongs
      // there. Resolves true when a page came in, so the caller checks again.
      async ensure(index, direction) {
        if (complete() || entries[index]?.detached) return false;
        const ring = slots.length;
        const crossing = direction > 0 ? mod(index + 1, ring) === mod(seam, ring) : mod(index, ring) === mod(seam, ring);
        if (!crossing) return false;
        const before = pagesLoaded;
        await loadPage(direction > 0 ? "forward" : "backward");
        return pagesLoaded > before;
      },
      // An entry's place among all posts, newest first.
      position(index) {
        const entry = entries[index];
        if (!totalEntries || !entry?.index) return null;
        return { index: totalEntries - entry.index + 1, total: totalEntries };
      },
      // Load ahead while the viewer is within a few entries of the seam.
      prefetch(index) {
        if (complete() || entries[index]?.detached) return;
        const ring = slots.length;
        if (mod(seam - 1 - index, ring) < 4) void loadPage("forward");
        else if (mod(index - seam, ring) < 4) void loadPage("backward");
      },
      keydown(event) {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "Tab") {
          keyboardIndex = null;
          viewport.classList.remove("is-keyboard-navigating");
          return;
        }
        if (paused || drag || event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
        // Enter opens the chosen slide only while focus is on the page or the rail itself.
        const onRail = event.target === document.body || viewport.contains(event.target);
        if (keyboardIndex !== null && onRail && (event.key === "Enter" || event.key === " ")) {
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
      get currentIndex() {
        return currentIndex >= 0 ? currentIndex : null;
      },
    };

    measure();
    new ResizeObserver(measure).observe(viewport);

    return rail;
  }

  // A grid of small images that loads more as you scroll.
  function createGrid() {
    const list = document.querySelector("[data-grid]");
    if (!list) return null;
    let more = document.querySelector("a.more[rel='next']");
    let loading = null;

    // Posts without an image are cards that link to their page; only images open the viewer.
    const links = () => [...list.querySelectorAll("a.cell[data-preview]:not([hidden])")];
    let cache = [];
    const refresh = () => {
      cache = links().map(readEntry);
    };
    refresh();

    function loadMore() {
      if (!more) return Promise.resolve();
      if (loading) return loading;
      const pagination = more.closest(".pagination");
      pagination?.classList.add("is-loading-more");
      loading = (async () => {
        try {
          const response = await fetch(more.href, { credentials: "same-origin" });
          if (!response.ok) throw new Error(`Could not load ${more.href}`);
          const doc = new DOMParser().parseFromString(await response.text(), "text/html");
          const added = [...doc.querySelectorAll("[data-grid] a.cell")];
          for (const cell of added) list.append(document.adoptNode(cell));
          const status = document.querySelector(".list-status");
          if (status && added.length) status.textContent = `${added.length} more ${added.length === 1 ? "post" : "posts"} loaded`;
          const next = doc.querySelector("a.more[rel='next']");
          if (next) more.href = next.href;
          else {
            more.closest(".pagination")?.remove();
            more = null;
          }
          refresh();
          observeSentinel();
        } catch (error) {
          // The link stays; look again shortly, since the sentinel may already be in view.
          setTimeout(observeSentinel, 5000);
        }
        pagination?.classList.remove("is-loading-more");
        loading = null;
      })();
      return loading;
    }

    let observer = null;
    function observeSentinel() {
      observer?.disconnect();
      if (!more) return;
      observer = new IntersectionObserver((records) => {
        if (records.some((record) => record.isIntersecting)) void loadMore();
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
      // An image's place among all the listing's posts (cards included), from the grid's
      // pagination; without pages, the listing is everything.
      position(index) {
        const all = [...list.querySelectorAll("a.cell")];
        const at = all.indexOf(cache[index]?.link);
        const total = Number(list.dataset.entries) || (more ? 0 : all.length);
        if (at < 0 || !total) return null;
        const offset = (Number(list.dataset.page) - 1 || 0) * (Number(list.dataset.pageSize) || 0);
        return { index: offset + at + 1, total };
      },
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

  if (view === "home" || (view === "entry" && root.classList.contains("rail-mode"))) controller = createRail();
  else if (view !== "entry") controller = createGrid();

  // No rail could be made, so let the entry page show its text instead.
  if (view === "entry" && !controller) root.classList.remove("rail-mode", "is-deep-open");

  // In rail mode the post's text is clipped out of sight, so keep focus out of it too. The
  // viewer's Info button shows it instead.
  const clippedText = view === "entry" && controller ? document.querySelector(".contents") : null;
  if (clippedText) clippedText.inert = true;

  if (view === "entry" && controller) {
    // The entry's own page: the viewer starts open, and closing returns to the rail.
    const index = controller.currentIndex ?? controller.entries().findIndex((entry) => entry.href === location.pathname);
    if (index >= 0) {
      history.replaceState({ ...history.state, keynote: "open", pushed: false }, "", location.href);
      void open(index, { animate: false });
    } else {
      root.classList.remove("is-deep-open");
    }
  }
})();
