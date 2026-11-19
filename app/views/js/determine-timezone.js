var timezoneInput = document.querySelector('input[name="timeZone"]');

if (timezoneInput) {
  var timezone;

  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (e) {}

  if (timezone) {
    timezoneInput.value = timezone;
  }

  const titleInput = document.getElementById("title_input");

  if (titleInput) {
    titleInput.focus();
    titleInput.select();
  }
}
