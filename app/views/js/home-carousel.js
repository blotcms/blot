// The buttons beside the homepage's templates. Without this script the row
// still scrolls sideways and the buttons stay hidden.

const carousel = document.querySelector("[data-home-carousel]");

if (carousel) {
  const previous = document.querySelector("[data-home-carousel-prev]");
  const next = document.querySelector("[data-home-carousel-next]");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const step = () => {
    const card = carousel.firstElementChild;
    if (!card) return carousel.clientWidth;
    const gap = parseFloat(getComputedStyle(carousel).columnGap) || 0;
    // Move by the cards that fit, so the next set lines up with the edge
    const width = card.getBoundingClientRect().width + gap;
    return Math.max(1, Math.floor(carousel.clientWidth / width)) * width;
  };

  const scroll = (direction) =>
    carousel.scrollBy({
      left: direction * step(),
      behavior: motion.matches ? "auto" : "smooth",
    });

  const update = () => {
    const end = carousel.scrollWidth - carousel.clientWidth - 1;
    previous.disabled = carousel.scrollLeft <= 0;
    next.disabled = carousel.scrollLeft >= end;
  };

  if (previous && next) {
    previous.hidden = false;
    next.hidden = false;
    previous.addEventListener("click", () => scroll(-1));
    next.addEventListener("click", () => scroll(1));
    carousel.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
  }
}
