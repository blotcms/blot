// Dismiss a flash message (partials/message.html) without reloading the page
document.addEventListener("click", function (e) {
  var button = e.target.closest && e.target.closest("[data-dismiss-message]");
  var message = button && button.closest(".flash");
  if (message) message.hidden = true;
});
