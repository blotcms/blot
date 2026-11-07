var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");

var TOO_LONG = "Choose a title under 70 characters";

module.exports = promiseOnly(async function validateTitle(blogID, title) {
  ensure(blogID, "string").and(title, "string");

  // Normalize to Unicode NFC
  title = title.normalize("NFC");

  // Remove leading and trailing whitespace
  title = title.trim();

  if (title.length > 70) throw new Error(TOO_LONG);

  return title;
});
