// <details data-dismissable> (the site switcher, the phone Menu) close on a
// click outside them, on Escape, and when another one opens.

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
