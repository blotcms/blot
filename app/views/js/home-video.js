// The homepage's video thumbnail (documentation/home-video.js draws it). It
// loops a short story: the pointer picks a file in the My site folder, moves
// to Safari, and the site scrolls down and back up. It plays only while the
// card is on screen; with reduced motion it stays a still frame. Clicking the
// card opens the video (js/watch.js, data-watch-trigger).

const springValue = require("./spring.js");

const card = document.querySelector(".home-video");
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

if (card && !motion.matches) {
  const scene = card.querySelector(".home-video-scene");
  const pointer = card.querySelector("[data-home-video-pointer]");
  const files = [...card.querySelectorAll(".home-video-finder .pane-tree li")];
  const file = files[2]; // Trip to France.docx
  const page = card.querySelector(".home-video-browser .pane-page");
  const site = card.querySelector(".home-video-site");

  // A point in the scene's own 1280 x 720 coordinates, whatever its scale
  const at = (el, fx, fy) => {
    const box = scene.getBoundingClientRect();
    const scale = box.width / scene.offsetWidth;
    const r = el.getBoundingClientRect();
    return {
      x: (r.left + r.width * fx - box.left) / scale,
      y: (r.top + r.height * fy - box.top) / scale,
    };
  };

  const px = springValue(300, (v) => (pointer.style.left = v + "px"));
  const py = springValue(640, (v) => (pointer.style.top = v + "px"));
  const pageY = springValue(0, (v) => {
    site.style.transform = "translateY(" + -v + "px)";
  });

  const go = (point, seconds) => {
    px.to(point.x, seconds);
    py.to(point.y, seconds);
  };

  const story = [
    [
      0,
      () => {
        file.classList.remove("pane-sel");
        go(at(file, 0.5, 0.35), 0.9);
      },
    ],
    [1100, () => file.classList.add("pane-sel")],
    [1900, () => go(at(page, 0.55, 0.45), 0.9)],
    [3000, () => pageY.to(site.offsetHeight - page.offsetHeight, 1.4)],
    [5000, () => pageY.to(0, 1.4)],
    [6400, () => go({ x: 300, y: 640 }, 0.9)],
  ];
  const length = 7800;
  let timers = [];
  let running = false;

  const play = () => {
    timers.forEach(clearTimeout);
    timers = story.map(([time, run]) => setTimeout(run, time));
    timers.push(setTimeout(() => running && play(), length));
  };

  const set = (on) => {
    if (on === running) return;
    running = on;
    if (on) return play();
    timers.forEach(clearTimeout);
    [px, py, pageY].forEach((value) => value.stop());
  };

  // Only play while the card can be seen and the tab is open
  let visible = true;
  const update = () => set(visible && !document.hidden);
  document.addEventListener("visibilitychange", update);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    }).observe(card);
  } else update();
}
