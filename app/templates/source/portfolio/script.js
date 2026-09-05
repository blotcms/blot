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

/*

Close button on entry page
--------------------------

Purpose of this script is to allow the close button on the
entry page to behave like the browser back button. It works
out how far back in your navigation history you'd need to
go to. It sort of simulates a popover 'Close' button, if the
entry were a modal window in a slideshow. You can go to the
next or previous entry but then still return to the last index
page. Why bother doing this? When you press back, your browser
will return you to the old scroll offset with great speed.

*/

var articles = [{{#all_entries}}'{{{url}}}'{{^last}},{{/last}}{{/all_entries}}];
var backIndex;

determineBackIndex();

function determineBackIndex () {
  var localHistory = sessionStorage.getItem("localHistory");

  if (localHistory) {
    try {
      localHistory = JSON.parse(localHistory);
    } catch (e) {
      localHistory = [];
    }
  } else {
    localHistory = [];
  }

  localHistory = localHistory.slice(-50);
  localHistory.push({ pathname: window.location.pathname });
  sessionStorage.setItem("localHistory", JSON.stringify(localHistory));

  // we go back in the list of visited pages until we find
  // an item which doesn't match a known entry's URL
  localHistory.reverse().forEach(function(href, i) {
    if (backIndex === undefined && articles.indexOf(decodeURIComponent(href.pathname)) === -1) {
      backIndex = i;
      return false;
    }
  });
}
// Safari does not re-run scripts when the page is navigated
// to using browser history, so we need to detect this event
// and re-calculate the index page in the history location.
window.addEventListener( "pageshow", function ( event ) {
  var historyTraversal = event.persisted || 
                         ( typeof window.performance != "undefined" && 
                              window.performance.navigation.type === 2 );
  if ( historyTraversal ) {
    determineBackIndex();
  }
});

function lastIndexPage() {
  // reset the list of pages visited
  sessionStorage.setItem("localHistory", JSON.stringify([]));
  if (backIndex !== undefined && -backIndex < 0 && window.history.length > backIndex) {
    window.history.go(-backIndex);    
  } else {
    window.location = '/';
  }
  return false;
}



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