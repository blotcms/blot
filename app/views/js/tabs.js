// A row of tabs wider than the screen scrolls sideways (css/tabs.css):
// bring the current one into view, so a phone shows which tab this is
var current = document.querySelector('.tabs__link[aria-current="page"]');
var list = current && current.closest(".tabs__list");

if (list && list.scrollWidth > list.clientWidth) {
  // Measured against the row: each tab's <li> is positioned, so offsetLeft
  // would be relative to that
  var tab = current.getBoundingClientRect();
  var row = list.getBoundingClientRect();
  var left = tab.left - row.left - (row.width - tab.width) / 2;
  list.scrollLeft = Math.max(0, left);
}
