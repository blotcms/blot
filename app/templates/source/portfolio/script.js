{{{app_js}}}



/*! instant.page v1.2.2 - (C) 2019 Alexandre Dieulot - https://instant.page/license */
let urlToPreload
let mouseoverTimer
let lastTouchTimestamp

const prefetcher = document.createElement('link')
const isSupported = prefetcher.relList && prefetcher.relList.supports && prefetcher.relList.supports('prefetch')
const isDataSaverEnabled = navigator.connection && navigator.connection.saveData
const allowQueryString = 'instantAllowQueryString' in document.body.dataset
const allowExternalLinks = 'instantAllowExternalLinks' in document.body.dataset

if (isSupported && !isDataSaverEnabled) {
  prefetcher.rel = 'prefetch'
  document.head.appendChild(prefetcher)

  const eventListenersOptions = {
    capture: true,
    passive: true,
  }
  document.addEventListener('touchstart', touchstartListener, eventListenersOptions)
  document.addEventListener('mouseover', mouseoverListener, eventListenersOptions)
}

function touchstartListener(event) {
  /* Chrome on Android calls mouseover before touchcancel so `lastTouchTimestamp`
   * must be assigned on touchstart to be measured on mouseover. */
  lastTouchTimestamp = performance.now()

  const linkElement = event.target.closest('a')

  if (!isPreloadable(linkElement)) {
    return
  }

  linkElement.addEventListener('touchcancel', touchendAndTouchcancelListener, {passive: true})
  linkElement.addEventListener('touchend', touchendAndTouchcancelListener, {passive: true})

  urlToPreload = linkElement.href
  preload(linkElement.href)
}

function touchendAndTouchcancelListener() {
  urlToPreload = undefined
  stopPreloading()
}

function mouseoverListener(event) {
  if (performance.now() - lastTouchTimestamp < 1100) {
    return
  }

  const linkElement = event.target.closest('a')

  if (!isPreloadable(linkElement)) {
    return
  }

  linkElement.addEventListener('mouseout', mouseoutListener, {passive: true})

  urlToPreload = linkElement.href

  mouseoverTimer = setTimeout(() => {
    preload(linkElement.href)
    mouseoverTimer = undefined
  }, 65)
}

function mouseoutListener(event) {
  if (event.relatedTarget && event.target.closest('a') == event.relatedTarget.closest('a')) {
    return
  }

  if (mouseoverTimer) {
    clearTimeout(mouseoverTimer)
    mouseoverTimer = undefined
  }
  else {
    urlToPreload = undefined
    stopPreloading()
  }
}

function isPreloadable(linkElement) {
  if (!linkElement || !linkElement.href) {
    return
  }

  if (urlToPreload == linkElement.href) {
    return
  }

  const preloadLocation = new URL(linkElement.href)

  if (!allowExternalLinks && preloadLocation.origin != location.origin && !('instant' in linkElement.dataset)) {
    return
  }

  if (!['http:', 'https:'].includes(preloadLocation.protocol)) {
    return
  }

  if (preloadLocation.protocol == 'http:' && location.protocol == 'https:') {
    return
  }

  if (!allowQueryString && preloadLocation.search && !('instant' in linkElement.dataset)) {
    return
  }

  if (preloadLocation.hash && preloadLocation.pathname + preloadLocation.search == location.pathname + location.search) {
    return
  }

  if ('noInstant' in linkElement.dataset) {
    return
  }

  return true
}

function preload(url) {
  prefetcher.href = url
}

function stopPreloading() {
  prefetcher.removeAttribute('href')
}

// end of instant.page

// Keep the collection an entry was opened from so its arrows stay within it.
// The chronological prev/next hrefs are only ever replaced once we know better.
var collectionKey = "portfolioCollection";
var cacheID = "{{cacheID}}";
var closeURL;
var closeDepth = 0;

var articles = [{{#all_entries}}'{{{url}}}'{{^last}},{{/last}}{{/all_entries}}];

// Close by walking back through the history entries pushed since the listing,
// so the browser restores the listing exactly as it was left.
function closeEntry() {
  if (closeDepth && closeDepth < window.history.length) {
    window.history.go(-closeDepth);
  } else {
    window.location.href = closeURL || '/';
  }
  return false;
}

// Each entry page remembers how many history entries sit between it and the
// listing. A page opened from the listing is one deep, and one reached with an
// arrow is one deeper than the page it was left from. The depth is handed over
// through sessionStorage, and kept in history.state so back, forward and
// reload see the same value.
var depthKey = "collectionDepth";

function handOverDepth(link, depth) {
  try {
    sessionStorage.setItem(depthKey, JSON.stringify({ path: pathOf(link.href), depth: depth }));
  } catch (e) {}
}

function takeDepth() {
  var saved = window.history.state && window.history.state.closeDepth;
  if (saved) return saved;
  try {
    var handed = JSON.parse(sessionStorage.getItem(depthKey));
    sessionStorage.removeItem(depthKey);
    return handed && handed.path === pathOf(window.location.href) ? handed.depth : 0;
  } catch (e) {
    return 0;
  }
}

document.addEventListener("click", function (e) {
  var link = e.target.closest("a.entry-next, a.entry-previous");
  if (link && closeDepth) handOverDepth(link, closeDepth + 1);
}, true);

function pathOf(url) {
  try {
    var u = new URL(url, window.location.href);
    return u.origin === window.location.origin ? u.pathname.replace(/\/+$/, "") || "/" : null;
  } catch (e) {
    return null;
  }
}

function parseListing(doc, url) {
  var entries = [];
  doc.querySelectorAll("a.collection-entry").forEach(function (a) {
    var path = pathOf(a.href);
    if (path && entries.indexOf(path) === -1) entries.push(path);
  });
  if (!entries.length) return null;

  function pagination(selector) {
    var a = doc.querySelector(selector);
    return a && a.getAttribute("href") ? a.href : null;
  }

  return {
    url: url.split("#")[0],
    entries: entries,
    next: pagination("a.collection-next"),
    previous: pagination("a.collection-previous")
  };
}

function readCollection() {
  try {
    return JSON.parse(sessionStorage.getItem(collectionKey));
  } catch (e) {
    return null;
  }
}

function writeCollection(state) {
  try {
    sessionStorage.setItem(collectionKey, JSON.stringify(state));
  } catch (e) {}
}

// Record the order shown by the listing before following one of its entries.
document.addEventListener("click", function (e) {
  var entryLink = e.target.closest("a.collection-entry");
  if (!entryLink) return;
  handOverDepth(entryLink, 1);
  var listing = parseListing(document, window.location.href);
  if (listing) writeCollection({ cacheID: cacheID, listings: [listing] });
}, true);

function loadListing(url) {
  return fetch(url, { credentials: "same-origin", cache: "no-cache" }).then(function (res) {
    if (!res.ok) throw new Error("Could not load collection page");
    return res.text().then(function (html) {
      return parseListing(new DOMParser().parseFromString(html, "text/html"), res.url);
    });
  });
}

// Follow a listing's pagination links, up to hops pages, until it has the entry.
function findEntry(url, path, direction, hops) {
  return loadListing(url).then(function (listing) {
    if (!listing || listing.entries.indexOf(path) > -1) return listing;
    return hops && listing[direction] ? findEntry(listing[direction], path, direction, hops - 1) : null;
  });
}

function initializeCollectionNavigation() {
  var state = readCollection();
  // Only trust the collection when arriving from elsewhere on this site.
  if (!state || !pathOf(document.referrer)) return;

  closeDepth = takeDepth();
  if (closeDepth) window.history.replaceState({ closeDepth: closeDepth }, "");

  var path = pathOf(window.location.href);
  var page = -1, index = -1;
  for (var n = 0; n < state.listings.length && index < 0; n++) {
    page = n;
    index = state.listings[n].entries.indexOf(path);
  }
  if (index < 0) return;

  // A publish changes cacheID and can push the entry onto a later page (or
  // pull it earlier), so find it in the current listing before using the order.
  if (state.cacheID !== cacheID) {
    var url = state.listings[page].url;
    findEntry(url, path, "next", 3).then(function (found) {
      return found || findEntry(url, path, "previous", 2);
    }).then(function (found) {
      if (!found) return;
      var fresh = { cacheID: cacheID, listings: [found] };
      writeCollection(fresh);
      followCollection(fresh, 0, found.entries.indexOf(path));
    }, function () {});
    return;
  }
  followCollection(state, page, index);
}

function followCollection(state, page, index) {
  var listing = state.listings[page];
  closeURL = listing.url;
  document.querySelectorAll("a.entry-close").forEach(function (a) {
    a.href = closeURL;
  });

  function edge(l, step) {
    return l.entries[step > 0 ? 0 : l.entries.length - 1];
  }

  // Resolves to the neighbour's path, null at the end of the collection, and
  // rejects when unsure (so the chronological link stays).
  function neighbor(direction) {
    // entry.next is the newer entry, so it sits earlier in the listing; the
    // listing's own "next" page is the older one.
    var step = direction === "next" ? -1 : 1;
    var pageLink = listing[direction === "next" ? "previous" : "next"];
    if (listing.entries[index + step]) return Promise.resolve(listing.entries[index + step]);

    var loaded = state.listings[page + step];
    if (loaded) return Promise.resolve(edge(loaded, step));
    if (!pageLink) return Promise.resolve(null);

    return loadListing(pageLink).then(function (fetched) {
      if (!fetched) return null;
      state.listings[step > 0 ? "push" : "unshift"](fetched);
      writeCollection(state);
      return edge(fetched, step);
    });
  }

  [["a.entry-previous", "previous"], ["a.entry-next", "next"]].forEach(function (pair) {
    var link = document.querySelector(pair[0]);
    if (!link) return;
    neighbor(pair[1]).then(function (target) {
      if (target) {
        link.href = window.location.origin + target;
      } else {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
      }
    }, function () {});
  });
}

initializeCollectionNavigation();

document.addEventListener("keydown", function (e) {
  var selector = { 37: "a.entry-next", 39: "a.entry-previous" }[e.keyCode];
  var link = selector && document.querySelector(selector);
  if (link && link.href) link.click();
});

var candidates = sessionStorage.getItem("randomPostCandidates");

try {
  candidates = JSON.parse(candidates);  
  candidates = candidates.filter(function(pathname){
    return articles.indexOf(pathname) > -1 && 
    pathname !== window.location.pathname
  });
  if (candidates.length === 0) candidates = articles;
} catch (e) {
  candidates = articles.slice();
}

sessionStorage.setItem("randomPostCandidates", JSON.stringify(candidates));

function randomPost () {

  window.location = candidates[Math.floor(Math.random() * candidates.length)];

  return false;
}
