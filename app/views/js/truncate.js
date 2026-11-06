// Middle truncation, like the macOS Finder: "A very long fi…name.md".
// The CSS for .truncate gives an end ellipsis until this runs. This keeps the
// full text in a title and re-fits whenever the container is resized or new
// .truncate elements are added (e.g. folder rows loaded on scroll).

var ELLIPSIS = "…";
var HEAD_SHARE = 0.6; // keep a little more of the start than the end
var canvas;

// Other scripts may replace the text (e.g. live sync status), so start again
// whenever it is not what this script last wrote.
function fullText(el) {
  if (el.__fullText === undefined || el.textContent !== el.__shown) {
    el.__fullText = el.__shown = el.textContent;
    if (!el.title || el.__setTitle) {
      el.title = el.__fullText.trim();
      el.__setTitle = true;
    }
  }
  return el.__fullText;
}

function isInteractive(el) {
  return /^(A|BUTTON|SUMMARY)$/.test(el.tagName) || el.hasAttribute("tabindex");
}

// Screen readers should hear the whole text, not "A very long fi…name.md".
// A link or button keeps its place in the accessibility tree and takes the
// full text as its name; other text is hidden from screen readers while
// shortened, with the full text beside it, visually hidden.
function announce(el, shortened) {
  if (isInteractive(el)) {
    // Leave a label the markup set alone
    if (el.hasAttribute("aria-label") && !el.__setLabel) return;
    if (shortened) {
      el.setAttribute("aria-label", el.__fullText.trim());
      el.__setLabel = true;
    } else if (el.__setLabel) {
      el.removeAttribute("aria-label");
      el.__setLabel = false;
    }
    return;
  }

  if (shortened) {
    if (!el.__fullTextForReaders) {
      el.__fullTextForReaders = document.createElement("span");
      el.__fullTextForReaders.className = "visually-hidden";
    }
    var reader = el.__fullTextForReaders;
    if (reader.textContent !== el.__fullText.trim()) {
      reader.textContent = el.__fullText.trim();
    }
    if (reader.parentNode !== el.parentNode || reader.previousSibling !== el) {
      el.parentNode.insertBefore(reader, el.nextSibling);
    }
    el.setAttribute("aria-hidden", "true");
  } else if (el.__fullTextForReaders) {
    if (el.__fullTextForReaders.parentNode) {
      el.__fullTextForReaders.parentNode.removeChild(el.__fullTextForReaders);
    }
    el.removeAttribute("aria-hidden");
  }
}

function show(el, text) {
  if (el.textContent !== text) el.textContent = text;
  el.__shown = text;
  if (el.parentNode) {
    announce(el, text.trim() !== el.__fullText.trim());
  }
}

function measurer(el) {
  var style = window.getComputedStyle(el);
  canvas = canvas || document.createElement("canvas");
  var context = canvas.getContext("2d");
  context.font = [
    style.fontStyle,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ].join(" ");
  return function (text) {
    return context.measureText(text).width;
  };
}

function shorten(chars, keep) {
  var head = Math.ceil(keep * HEAD_SHARE);
  var tail = keep - head;
  return (
    chars.slice(0, head).join("") +
    ELLIPSIS +
    (tail ? chars.slice(chars.length - tail).join("") : "")
  );
}

// The longest middle-truncated text that fits, by binary search on the
// number of characters kept.
function fit(text, available, measure) {
  var chars = Array.from(text.trim());
  var low = 0;
  var high = chars.length - 1;

  while (low < high) {
    var mid = Math.ceil((low + high) / 2);
    if (measure(shorten(chars, mid)) <= available) low = mid;
    else high = mid - 1;
  }

  return shorten(chars, low);
}

function truncate(elements) {
  // Write, then read, then write, so the page lays out once per batch
  elements.forEach(function (el) {
    show(el, fullText(el));
  });

  var overflowing = elements.filter(function (el) {
    return el.clientWidth > 0 && el.scrollWidth > el.clientWidth;
  });

  var available = overflowing.map(function (el) {
    return el.clientWidth;
  });

  overflowing.forEach(function (el, i) {
    show(el, fit(fullText(el), available[i] - 1, measurer(el)));
  });
}

var pending = [];
var scheduled = false;

function schedule(elements) {
  elements.forEach(function (el) {
    if (pending.indexOf(el) === -1) pending.push(el);
  });
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(function () {
    var batch = pending;
    pending = [];
    scheduled = false;
    truncate(
      batch.filter(function (el) {
        return el.isConnected;
      })
    );
  });
}

// Watch each element's parent: its width does not depend on how much of the
// text is shown, so re-fitting cannot trigger itself.
var resizeObserver =
  window.ResizeObserver &&
  new ResizeObserver(function (entries) {
    var changed = [];
    entries.forEach(function (entry) {
      var parent = entry.target;
      var width = Math.round(entry.contentRect.width);
      if (parent.__truncateWidth === width) return;
      parent.__truncateWidth = width;
      changed = changed.concat(parent.__truncateChildren || []);
    });
    schedule(changed);
  });

function watch(el) {
  if (el.__truncateWatched) return;
  el.__truncateWatched = true;
  var parent = el.parentElement;
  if (!parent || !resizeObserver) return;
  parent.__truncateChildren = parent.__truncateChildren || [];
  parent.__truncateChildren.push(el);
  resizeObserver.observe(parent);
}

function init(root) {
  var elements = Array.from(root.querySelectorAll(".truncate"));
  if (root.classList && root.classList.contains("truncate"))
    elements.push(root);
  elements.forEach(watch);
  schedule(elements);
}

function start() {
  init(document);

  if (!resizeObserver) {
    window.addEventListener("resize", function () {
      schedule(Array.from(document.querySelectorAll(".truncate")));
    });
  }

  // Web fonts change text widths
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      schedule(Array.from(document.querySelectorAll(".truncate")));
    });
  }

  if (window.MutationObserver) {
    new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) init(node);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
}

// On dashboard pages this runs inline at the end of <body> (built into
// partials/truncate-script.html), when the page's text is already parsed: the
// first fit then lands in the frame before the first paint. The documentation
// bundle runs it deferred.
if (document.body) {
  start();
} else {
  document.addEventListener("DOMContentLoaded", start);
}
