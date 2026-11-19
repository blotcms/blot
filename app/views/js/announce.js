// Reads a short status message to screen readers through the page's one
// polite announcer (#dashboard-announcer in partials/layout.html). Clearing
// it first means the same message twice is read twice.
module.exports = function announce(message) {
  var announcer = document.getElementById("dashboard-announcer");
  if (!announcer || !message) return;
  announcer.textContent = "";
  setTimeout(function () {
    announcer.textContent = message;
  }, 50);
};
