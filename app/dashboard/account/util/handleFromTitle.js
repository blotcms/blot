const randomChars = require("./randomChars");

function handleFromTitle(title) {
  var handle = title.toLowerCase().replace(/\W/g, "");

  if (handle.length < 4) {
    handle += randomChars(4 - handle.length);
  }

  return handle;
}

module.exports = handleFromTitle;
