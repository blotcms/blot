// The homepage's mini player (partials/home-preview.html). It loops a short
// story, a pointer opening a file and the site scrolling to the new post, and
// on wide screens rides from its place in the hero to the bottom-left corner
// over the first 600px of scrolling. Dragging moves it; clicking pauses it.
// With reduced motion it stays a still frame in the hero.

const preview = document.querySelector("[data-home-preview]");
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

// A critically damped spring that settles in about `seconds`, on rAF. The
// value keeps its velocity when retargeted, so the pointer never jolts.
function springValue(value, onUpdate) {
  let velocity = 0;
  let frame = null;
  onUpdate(value);

  return {
    to(target, seconds) {
      const omega = (2 * Math.PI) / (1.2 * seconds);
      let last = performance.now();
      cancelAnimationFrame(frame);
      const tick = (now) => {
        // Small steps keep the integration stable after a dropped frame
        const dt = Math.min(0.064, (now - last) / 1000);
        last = now;
        const force = -omega * omega * (value - target) - 2 * omega * velocity;
        velocity += force * dt;
        value += velocity * dt;
        if (Math.abs(value - target) < 0.1 && Math.abs(velocity) < 1) {
          value = target;
          velocity = 0;
          onUpdate(value);
          return;
        }
        onUpdate(value);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(frame);
    },
  };
}

if (preview && !motion.matches) {
  const slot = preview.parentElement;
  const hit = preview.querySelector(".home-preview-hit");
  const page = preview.querySelector("[data-home-preview-page]");
  const file = preview.querySelector("[data-home-preview-file]");
  const pointer = preview.querySelector("[data-home-preview-pointer]");

  // The story, on the 1280 x 720 scene
  const px = springValue(240, (v) => (pointer.style.left = v + "px"));
  const py = springValue(600, (v) => (pointer.style.top = v + "px"));
  const pageY = springValue(0, (v) => {
    page.style.transform = "translateY(" + -v + "px)";
  });

  const story = [
    [
      0,
      () => {
        px.to(330, 0.9);
        py.to(420, 0.9);
        file.classList.remove("is-selected");
        pageY.to(0, 0.6);
      },
    ],
    [1100, () => file.classList.add("is-selected")],
    [
      1900,
      () => {
        px.to(880, 0.9);
        py.to(360, 0.9);
      },
    ],
    [3000, () => pageY.to(300, 1.2)],
    [4800, () => pageY.to(0, 1.2)],
    [
      6000,
      () => {
        px.to(240, 0.9);
        py.to(600, 0.9);
      },
    ],
  ];
  const length = 7400;
  let timers = [];
  let playing = true;

  const play = () => {
    timers.forEach(clearTimeout);
    timers = story.map(([at, run]) => setTimeout(run, at));
    timers.push(setTimeout(() => playing && play(), length));
  };

  const pause = () => {
    timers.forEach(clearTimeout);
    [px, py, pageY].forEach((value) => value.stop());
  };

  // Only play while the card can be seen and the tab is open
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
    else if (playing) play();
  });

  // On wide screens the card rides from its slot to the bottom-left corner
  const wide = window.matchMedia("(min-width: 1001px)");
  const travel = 600;
  const margin = 20;
  const offset = { x: 0, y: 0 };
  let riding = false;

  const place = () => {
    if (!riding) return;
    const box = slot.getBoundingClientRect();
    const width = preview.offsetWidth;
    const height = preview.offsetHeight;
    // Where the slot was before any scrolling
    const x0 = box.left;
    const y0 = box.top + window.scrollY;
    const x1 = margin;
    const y1 = window.innerHeight - height - margin;
    const t = Math.min(Math.max(window.scrollY / travel, 0), 1);
    const x = Math.min(
      Math.max(x0 + (x1 - x0) * t + offset.x, 0),
      window.innerWidth - width
    );
    const y = Math.min(
      Math.max(y0 - window.scrollY * (1 - t) + (y1 - y0) * t + offset.y, 0),
      window.innerHeight - height
    );
    preview.style.transform = "translate3d(" + x + "px, " + y + "px, 0)";
  };

  const ride = () => {
    riding = wide.matches;
    preview.classList.toggle("is-riding", riding);
    if (!riding) {
      preview.style.transform = "";
      offset.x = offset.y = 0;
    }
    place();
  };

  // It steps aside once the footer comes up, so it never covers its links
  const footer = document.querySelector(".site-footer");
  if (footer && "IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      preview.classList.toggle("is-hidden", riding && entry.isIntersecting);
    }).observe(footer);
  }

  window.addEventListener("scroll", place, { passive: true });
  window.addEventListener("resize", place);
  wide.addEventListener("change", ride);
  ride();

  // A drag moves the card, kept as an offset from its path; a click without
  // a drag pauses or plays the loop
  let press = null;
  let dragged = false;

  preview.addEventListener("pointerdown", (event) => {
    if (!riding || event.button !== 0) return;
    press = { x: event.clientX, y: event.clientY, start: { ...offset } };
    dragged = false;
  });

  window.addEventListener("pointermove", (event) => {
    if (!press) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) {
      dragged = true;
      preview.classList.add("is-dragging");
    }
    offset.x = press.start.x + dx;
    offset.y = press.start.y + dy;
    place();
  });

  window.addEventListener("pointerup", () => {
    press = null;
    preview.classList.remove("is-dragging");
  });

  hit.addEventListener("click", (event) => {
    if (dragged) {
      dragged = false;
      event.preventDefault();
      return;
    }
    playing = !playing;
    hit.setAttribute("aria-pressed", String(!playing));
    hit.setAttribute(
      "aria-label",
      playing ? "Pause the preview" : "Play the preview"
    );
    if (playing) play();
    else pause();
  });

  play();
}
