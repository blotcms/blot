var RE2 = require("re2");

function isRegex(string) {
  return (
    string &&
    (string.slice(0, 1) === "\\" ||
      string.indexOf("(.*)") !== -1 ||
      string.indexOf("$1") !== -1)
  );
}

function is(input, from) {
  try {
    // RE2 matches in linear time, so a redirect's 'from' pattern can't be
    // crafted to hang the process the way a backtracking RegExp can.
    from = new RE2(from, "i");
  } catch (e) {
    return false;
  }
  return from.test(input);
}

function notRegex(string) {
  return !isRegex(string);
}

function map(input, from, to) {
  try {
    from = new RE2(from, "i");
  } catch (e) {
    return null;
  }
  return input.replace(from, to);
}

function matches(to, mappings) {
  for (var i = 0; i < mappings.length; i++) {
    var from = mappings[i].from;

    if (from === to) {
      return true;
    }

    if (isRegex(from) && is(to, from)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  isRegex: isRegex,
  notRegex: notRegex,
  map: map,
  is: is,
  matches: matches,
};
