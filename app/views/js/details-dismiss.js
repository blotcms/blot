// <details data-dismissable> (the site switcher, the phone Menu) close on a
// click outside them, on Escape, when another one opens, and when keyboard
// focus moves out of them (an open menu would cover what Tab lands on next).

function openOnes() {
  return Array.from(
    document.querySelectorAll("details[data-dismissable][open]")
  );
}

document.addEventListener("click", function (event) {
  openOnes().forEach(function (details) {
    if (!details.contains(event.target)) details.removeAttribute("open");
  });
});

document.addEventListener("keydown", function (event) {
  if (event.key !== "Escape") return;
  openOnes().forEach(function (details) {
    details.removeAttribute("open");
    var summary = details.querySelector("summary");
    if (summary && details.contains(document.activeElement)) summary.focus();
  });
});

document.addEventListener("focusout", function (event) {
  var next = event.relatedTarget;
  // No next element: focus left the window or went to the page itself
  if (!next) return;
  openOnes().forEach(function (details) {
    if (details.contains(event.target) && !details.contains(next)) {
      details.removeAttribute("open");
    }
  });
});
