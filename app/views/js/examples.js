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

  const shuffleArray = (array) => array.sort(() => Math.random() - 0.5);

  const sitesArray = Array.prototype.slice.call(
    featured.querySelectorAll(itemSelector)
  );
  const previousHrefs = JSON.parse(
    localStorage.getItem(storageKey) || "[]"
  );

  let topOfListCandidates = [...sitesArray];

  shuffleArray(topOfListCandidates);

  let maxFilterable = topOfListCandidates.length - topOfListLength;

  console.log("totalSites", sitesArray.length);
  console.log("maxFilterable", maxFilterable);
  console.log("previousHrefs", previousHrefs);

  if (maxFilterable > 0) {
    // remove any sites that were in the previous top of list until we have enough
    topOfListCandidates = topOfListCandidates.filter(function (site) {
      const wouldLikeToKeep = !previousHrefs.includes(site.querySelector("a").href);

      if (wouldLikeToKeep) {
        console.log("Keeping", site);
        return true;
      }

      if (!wouldLikeToKeep) {
        console.log("Would like to remove", site);
        maxFilterable--;
      }

      return maxFilterable >= 0 && wouldLikeToKeep;
    });
  }

  shuffleArray(topOfListCandidates);

  const topOfList = topOfListCandidates.slice(0, topOfListLength);

  let remainder = [...sitesArray].filter(function (site) {
    return !topOfList.includes(site);
  });

  shuffleArray(remainder);

  // trim the number of sites
  remainder = remainder.slice(0, totalSites - topOfListLength);

  // save the results for the next pass
  const hrefs = topOfList.map((site) => site.querySelector("a").href);
  localStorage.setItem(storageKey, JSON.stringify(hrefs));

  const anchor = anchorSelector ? featured.querySelector(anchorSelector) : null;

  if (!anchor) {
    sitesArray.forEach(function (site) {
      site.remove();
    });
  }

  const result = [...topOfList, ...remainder];

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

renderFeatured({
  id: "featured",
  topOfListLength: 9,
  totalSites: 16,
  storageKey: "previousHrefs",
});

renderFeatured({
  id: "home-featured-grid",
  itemSelector: ".home-featured-item",
  anchorSelector: ".home-featured-action",
  topOfListLength: 9,
  totalSites: 27,
  storageKey: "homePreviousHrefs",
  fadeIn: true,
});
