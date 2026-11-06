(function () {
  "use strict";

  function setExpanded(callout, expanded) {
    var title = callout.querySelector(".callout-title");
    callout.classList.toggle("is-expanded", expanded);
    callout.classList.toggle("is-collapsed", !expanded);
    title.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function activate(event) {
    if (
      event.type === "keydown" &&
      event.key !== "Enter" &&
      event.key !== " "
    ) {
      return;
    }
    if (event.type === "keydown") event.preventDefault();
    var callout = event.currentTarget.parentElement;
    setExpanded(callout, !callout.classList.contains("is-expanded"));
  }

  function initialize() {
    document
      .querySelectorAll(".callout[data-callout-fold]")
      .forEach(function (callout) {
        var title = callout.firstElementChild;
        if (!title || !title.classList.contains("callout-title")) return;
        setExpanded(callout, callout.getAttribute("data-callout-fold") === "+");
        callout.classList.add("callout-fold-ready");
        title.addEventListener("click", activate);
        title.addEventListener("keydown", activate);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
