const MAX_HISTORY_LENGTH = 3;
const MAX_SHUFFLE_ATTEMPTS = 40;

const shuffleArray = (array) => {
  for (let index = array.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [array[index], array[randomIndex]] = [
      array[randomIndex],
      array[index],
    ];
  }

  return array;
};

const getSiteHref = (site) => site.querySelector("a").href;

const readRecentOrders = (storageKey) => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) || "[]");

    if (!Array.isArray(stored) || stored.length === 0) return [];

    // Migrate the old format, which stored only the previous top-of-list hrefs.
    const orders = typeof stored[0] === "string" ? [stored] : stored;

    return orders
      .filter(
        (order) =>
          Array.isArray(order) &&
          order.every((href) => typeof href === "string")
      )
      .slice(0, MAX_HISTORY_LENGTH);
  } catch (error) {
    return [];
  }
};

const saveRecentOrders = (storageKey, order, recentOrders) => {
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([order, ...recentOrders].slice(0, MAX_HISTORY_LENGTH))
    );
  } catch (error) {
    // The featured sites should still render if local storage is unavailable.
  }
};

const freshnessScore = (sites, recentOrders) => {
  const hrefs = sites.map(getSiteHref);

  return recentOrders.reduce((total, previousOrder, historyIndex) => {
    const previousPositions = new Map(
      previousOrder.map((href, position) => [href, position])
    );
    const historyWeight = 1 / (historyIndex + 1);

    return (
      total +
      hrefs.reduce((score, href, position) => {
        const previousPosition = previousPositions.get(href);

        if (previousPosition === undefined) return score;

        const distance = Math.abs(position - previousPosition);

        if (distance === 0) return score + 10 * historyWeight;
        if (distance <= 2) return score + 4 * historyWeight;
        if (distance <= 5) return score + historyWeight;

        return score;
      }, 0)
    );
  }, 0);
};

const createFreshOrder = ({
  sitesArray,
  topOfListLength,
  totalSites,
  recentOrders,
}) => {
  const visibleCount = Math.min(totalSites, sitesArray.length);
  const topCount = Math.min(topOfListLength, visibleCount);
  const previousTopHrefs = new Set(
    (recentOrders[0] || []).slice(0, topCount)
  );

  let bestOrder = [];
  let bestScore = Infinity;

  for (let attempt = 0; attempt < MAX_SHUFFLE_ATTEMPTS; attempt++) {
    const shuffledSites = shuffleArray([...sitesArray]);
    const top = shuffledSites
      .filter((site) => !previousTopHrefs.has(getSiteHref(site)))
      .slice(0, topCount);

    if (top.length < topCount) {
      top.push(
        ...shuffledSites
          .filter((site) => !top.includes(site))
          .slice(0, topCount - top.length)
      );
    }

    const remainder = shuffledSites
      .filter((site) => !top.includes(site))
      .slice(0, visibleCount - top.length);
    const candidate = [...top, ...remainder];
    const score = freshnessScore(candidate, recentOrders);

    if (score < bestScore) {
      bestOrder = candidate;
      bestScore = score;
    }

    if (score === 0) break;
  }

  return bestOrder;
};

const renderFeatured = ({
  id,
  itemSelector = "li",
  anchorSelector = null,
  topOfListLength,
  totalSites,
  storageKey,
  fadeIn = false,
}) => {
  const featured = document.getElementById(id);

  if (!featured) return;

  const sitesArray = Array.prototype.slice.call(
    featured.querySelectorAll(itemSelector)
  );
  const recentOrders = readRecentOrders(storageKey);
  const result = createFreshOrder({
    sitesArray,
    topOfListLength,
    totalSites,
    recentOrders,
  });

  saveRecentOrders(
    storageKey,
    result.map(getSiteHref),
    recentOrders
  );

  const anchor = anchorSelector ? featured.querySelector(anchorSelector) : null;

  sitesArray.forEach(function (site) {
    if (!result.includes(site)) site.remove();
  });

  if (fadeIn) {
    featured.classList.add("home-fade-enabled");

    const fadeStart = performance.now();
    const fadeDelays = new Map();
    let finalDelay = 0;

    shuffleArray([...result]).forEach(function (site, index) {
      const delay = index * 0.018 + Math.random() * 0.06;
      finalDelay = Math.max(finalDelay, delay);
      fadeDelays.set(site, delay);
    });

    const buttonDelay = finalDelay + 0.06;
    let avatarsStarted = 0;

    const startButton = () => {
      if (!anchor) return;

      const elapsed = (performance.now() - fadeStart) / 1000;
      const remaining = Math.max(0.06, buttonDelay - elapsed);
      window.setTimeout(() => anchor.classList.add("home-fade-in"), remaining * 1000);
    };

    const waitForImage = (site, plannedDelay) => {
      let started = false;

      const startAvatar = () => {
        if (started) return;
        started = true;

        const elapsed = (performance.now() - fadeStart) / 1000;
        const remaining = Math.max(0, plannedDelay - elapsed);

        window.setTimeout(() => {
          site.classList.add("home-fade-in");
          avatarsStarted++;

          if (avatarsStarted === result.length) startButton();
        }, remaining * 1000);
      };

      const image = site.querySelector("img");

      if (!image || image.complete) {
        startAvatar();
        return;
      }

      image.addEventListener("load", startAvatar, { once: true });
      image.addEventListener("error", startAvatar, { once: true });
    };

    result.forEach((site) => waitForImage(site, fadeDelays.get(site)));

    if (result.length === 0) startButton();
  }

  result.forEach(function (site) {
    if (anchor) {
      featured.insertBefore(site, anchor);
    } else {
      featured.appendChild(site);
    }
  });
};

[
  {
    id: "featured",
    totalSites: 16,
    storageKey: "previousHrefs",
  },
  {
    id: "home-featured-grid",
    itemSelector: ".home-featured-item",
    anchorSelector: ".home-featured-action",
    totalSites: 27,
    storageKey: "homePreviousHrefs",
    fadeIn: true,
  },
].forEach((options) => {
  renderFeatured({
    topOfListLength: 9,
    ...options,
  });
});
