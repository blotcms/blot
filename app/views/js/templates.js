const shuffle = (array) => {
  for (let index = array.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [array[index], array[randomIndex]] = [array[randomIndex], array[index]];
  }

  return array;
};

const initTemplateHero = () => {
  const hero = document.querySelector(".templates-hero");

  if (!hero) return;

  const grid = hero.querySelector(".templates-hero-grid");
  const images = Array.from(hero.querySelectorAll(".templates-hero-image"));
  const fadeStart = performance.now();
  const shuffledImages = shuffle([...images]);

  hero.classList.add("templates-hero-animations-enabled");

  images.forEach((image, index) => {
    const plannedDelay = index * 0.025 + Math.random() * 0.1;
    let started = false;

    const startImage = () => {
      if (started) return;
      started = true;

      const elapsed = (performance.now() - fadeStart) / 1000;
      const remaining = Math.max(0, plannedDelay - elapsed);

      window.setTimeout(() => {
        image.classList.add("templates-hero-image-ready");
      }, remaining * 1000);
    };

    const sourceImage = Array.from(image.querySelectorAll("img")).find(
      (candidate) => getComputedStyle(candidate).display !== "none"
    );

    if (!sourceImage || sourceImage.complete) {
      startImage();
      return;
    }

    sourceImage.addEventListener("load", startImage, { once: true });
    sourceImage.addEventListener("error", startImage, { once: true });
  });

  shuffledImages.forEach((image) => grid.appendChild(image));
};

const initTemplateGrid = () => {
  const grid = document.getElementById("template-grid");

  if (!grid) return;

  const items = Array.from(grid.querySelectorAll(".template-item"));

  const sortToggle = document.getElementById("template-sort");
  let activeSort = sortToggle?.dataset.defaultSort;

  const sortBy = (key) => {
    const sorted = [...items].sort((a, b) => {
      const aValue = Number(a.dataset[key]) || 0;
      const bValue = Number(b.dataset[key]) || 0;
      return bValue - aValue;
    });

    sorted.forEach((item) => grid.appendChild(item));
  };

  if (sortToggle) {
    const sortLinks = Array.from(sortToggle.querySelectorAll("a[data-sort]"));

    const setSort = (sort) => {
      activeSort = sort;
      sortLinks.forEach((link) =>
        link.classList.toggle("selected", link.dataset.sort === activeSort)
      );
      grid.dataset.sort = activeSort;
      sortBy(activeSort === "popular" ? "popularity" : "latest");
    };

    if (activeSort) {
      setSort(activeSort);
    } else {
      grid.dataset.sort = "relevance";
    }

    sortLinks.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        setSort(link.dataset.sort);
      });
    });
  }

  // --- Search: title (heavy) + README, ranked server-side ---
  // A search always navigates to /templates/search/:query for real,
  // rather than filtering the current page's grid in place. That grid
  // only ever contains the current category's templates (or none, on
  // the search page itself), so a local filter would silently come up
  // empty for a match outside it. A real navigation also drops whatever
  // category filter was active, which is the correct behaviour for a
  // search across every template.
  const searchInput = document.getElementById("template-search-input");

  if (!searchInput) return;

  const submitSearch = () => {
    const query = searchInput.value.trim();

    window.location.href = query
      ? "/templates/search/" + encodeURIComponent(query)
      : "/templates";
  };

  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitSearch();
  });

  // Fires when the input's native clear ("x") button is used.
  searchInput.addEventListener("search", submitSearch);
};

initTemplateHero();
initTemplateGrid();
