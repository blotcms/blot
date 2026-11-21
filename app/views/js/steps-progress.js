// Animates a step in a .steps-progress checklist (dashboard/css/
// steps-progress.css) that has finished since the page last showed it:
// across the live re-renders of .live-updates (sync_status.js) and across a
// reload, such as the one after a setup form is sent. Steps already done the
// first time a page shows them are left still, so a re-render doesn't replay
// them. Steps are matched by their data-step name, remembered per page path
// or per the list's data-steps-key.

var PREFIX = "steps-progress:";
var STAGGER = 0.12; // seconds between steps that finish together

function keyFor(list) {
  return PREFIX + (list.getAttribute("data-steps-key") || location.pathname);
}

function read(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key));
  } catch (e) {
    return null;
  }
}

function write(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Private windows and blocked storage: the steps just don't animate
  }
}

// What each list's steps were the last time this page showed them, by key
var known = {};

function update() {
  var lists = document.querySelectorAll(".steps-progress");
  // Lists that share a key (several on one page path) are remembered
  // together: each one's steps read and write the same record
  var before = {};
  var next = {};

  for (var l = 0; l < lists.length; l++) {
    var key = keyFor(lists[l]);
    if (!(key in before)) {
      before[key] = key in known ? known[key] : read(key);
      next[key] = {};
    }

    var steps = lists[l].querySelectorAll(":scope > ol > li[data-step]");
    var delay = 0;

    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      var name = step.getAttribute("data-step");
      var done = step.classList.contains("done");
      var was = before[key];
      next[key][name] = done;

      if (done && was && was[name] === false) {
        step.style.setProperty("--step-delay", delay + "s");
        step.classList.add("became-done");
        delay += STAGGER;
      }
    }
  }

  for (var k in next) {
    known[k] = next[k];
    write(k, next[k]);
  }
}

function start() {
  update();

  // sync_status.js swaps the children of .live-updates on each re-render,
  // which can bring a checklist in that the page didn't load with
  var live = document.querySelector(".live-updates");
  if (!live || !window.MutationObserver) return;

  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++)
      if (records[i].type === "childList" && records[i].target === live)
        return update();
  }).observe(live, { childList: true });
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", start);
else start();
