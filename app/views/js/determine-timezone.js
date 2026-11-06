const jstz = require("./tz_detect.js");

var timezoneInput = document.querySelector('input[name="timeZone"]');

if (timezoneInput) {
  var timezone = jstz.determine();

  if (timezone) {
    timezoneInput.value = timezone.name();
  }

  const titleInput = document.getElementById("title_input");

  if (titleInput) {
    titleInput.focus();
    titleInput.select();
  }
}
