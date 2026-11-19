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
