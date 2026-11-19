// Infinite scroll for blot.im/discover. The "More posts" link points at the
// next page; when it comes into view, fetch that page and move its cards
// into the grid. Without JavaScript the link still works.

function init() {
  const grid = document.getElementById("discover-grid");
  if (!grid || !("IntersectionObserver" in window)) return;

  let loading = false;

  const observer = new IntersectionObserver(
    (records) => {
      if (records.some((record) => record.isIntersecting)) load();
    },
    { rootMargin: "800px 0px" }
  );

  function watch() {
    const more = document.getElementById("discover-more");
    if (more) observer.observe(more);
  }

  async function load() {
    const more = document.getElementById("discover-more");
    if (!more || loading) return;

    loading = true;

    try {
      const response = await fetch(more.href, {
        headers: { Accept: "text/html" },
      });

      if (!response.ok) throw new Error("HTTP " + response.status);

      const page = new DOMParser().parseFromString(
        await response.text(),
        "text/html"
      );

      const cards = page.querySelectorAll("#discover-grid > li");
      for (const card of cards) grid.appendChild(document.adoptNode(card));
      updateAllArrows();

      const next = page.getElementById("discover-more");
      observer.unobserve(more);

      if (next) {
        more.href = next.href;
        watch();
      } else {
        more.remove();
      }
    } catch (err) {
      // Leave the link, so it can be clicked instead
      observer.unobserve(more);
    } finally {
      loading = false;
    }
  }

  watch();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Photo carousels on cards with more than one photo. The arrows scroll by
// most of a view and hide at either end. Listeners are on the document, so
// cards added by the infinite scroll work too.
function updateArrows(carousel) {
  const track = carousel.querySelector(".discover-track");
  const prev = carousel.querySelector(".discover-prev");
  const next = carousel.querySelector(".discover-next");
  if (!track || !prev || !next) return;

  const end = track.scrollWidth - track.clientWidth - 2;
  prev.hidden = track.scrollLeft <= 2;
  next.hidden = track.scrollLeft >= end;
}

function updateAllArrows() {
  document.querySelectorAll(".discover-carousel").forEach(updateArrows);
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".discover-prev, .discover-next");
  if (!button) return;

  const carousel = button.closest(".discover-carousel");
  const track = carousel.querySelector(".discover-track");
  const direction = button.classList.contains("discover-next") ? 1 : -1;

  track.scrollBy({
    left: direction * track.clientWidth * 0.8,
    behavior: "smooth",
  });
});

document.addEventListener(
  "scroll",
  (event) => {
    const carousel =
      event.target.closest && event.target.closest(".discover-carousel");
    if (carousel) updateArrows(carousel);
  },
  true
);

// Photos change the track's width as they load
document.addEventListener(
  "load",
  (event) => {
    const carousel =
      event.target.closest && event.target.closest(".discover-carousel");
    if (carousel) updateArrows(carousel);
  },
  true
);

window.addEventListener("resize", updateAllArrows);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", updateAllArrows);
} else {
  updateAllArrows();
}

// The popover shown on hovering a name or avatar, in the feed or the sites
// box. It is centred under the name, 8px below it (above it when there is no
// room below), and kept inside the window. It opens after a short pause and
// stays open while the pointer is on it. Only for pointers which hover.
const POPOVER_TRIGGERS =
  ".discover-card .discover-name, .discover-card .discover-avatar-link, .discover-sites li > a";
const POPOVER_GAP = 8;
const POPOVER_MARGIN = 8;
const OPEN_DELAY = 300;
const CLOSE_DELAY = 150;

let openPopover = null;
let openTimer = null;
let closeTimer = null;

function popoverFor(trigger) {
  const item = trigger.closest(".discover-card, .discover-sites li");
  if (!item) return null;

  return {
    popover: item.querySelector(".discover-popover"),
    anchor:
      item.querySelector(".discover-name, .discover-site-name") || trigger,
  };
}

function place(popover, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;

  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(
    POPOVER_MARGIN,
    Math.min(
      left,
      document.documentElement.clientWidth - width - POPOVER_MARGIN
    )
  );

  let top = rect.bottom + POPOVER_GAP;
  if (top + height > document.documentElement.clientHeight - POPOVER_MARGIN)
    top = Math.max(POPOVER_MARGIN, rect.top - POPOVER_GAP - height);

  popover.style.left = Math.round(left) + "px";
  popover.style.top = Math.round(top) + "px";
}

function closePopover() {
  if (openPopover) openPopover.classList.remove("open");
  openPopover = null;
}

function showPopover(popover, anchor) {
  if (openPopover && openPopover !== popover) closePopover();
  popover.classList.add("open");
  place(popover, anchor);
  openPopover = popover;
}

if (window.matchMedia && window.matchMedia("(hover: hover)").matches) {
  document.addEventListener("mouseover", (event) => {
    const onPopover = event.target.closest(".discover-popover");
    const trigger = event.target.closest(POPOVER_TRIGGERS);

    if (onPopover || trigger) clearTimeout(closeTimer);
    if (!trigger) return;

    const found = popoverFor(trigger);
    if (!found || !found.popover || found.popover === openPopover) return;

    clearTimeout(openTimer);
    openTimer = setTimeout(
      () => showPopover(found.popover, found.anchor),
      openPopover ? 0 : OPEN_DELAY
    );
  });

  document.addEventListener("mouseout", (event) => {
    const leaving = event.target.closest(
      POPOVER_TRIGGERS + ", .discover-popover"
    );
    if (!leaving) return;

    const to = event.relatedTarget;
    if (
      to &&
      to.closest &&
      to.closest(POPOVER_TRIGGERS + ", .discover-popover")
    )
      return;

    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closePopover, CLOSE_DELAY);
  });

  window.addEventListener("scroll", closePopover, { passive: true });
  window.addEventListener("resize", closePopover);
}
