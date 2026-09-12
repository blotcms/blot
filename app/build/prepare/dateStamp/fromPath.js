var moment = require("moment");

function fromPath(path) {
  var created, parsed, fileName, tokens, hasTime;
  var year, month, day;
  var hour, minute, second;

  path = path.trim();

  if (!path) return false;

  // '/1/2/3-4.txt' -> ['',1','2','3','4.txt']
  tokens = path.split(/-|\/|_|\s|\./);

  for (var i = 0; i < tokens.length; i++) {
    // There aren't enough remaing tokens to form
    // a valid date. This show stops now.
    if (tokens[i + 2] === undefined) break;

    year = parseYear(tokens[i]);
    month = parseMonth(tokens[i + 1]);
    day = parseDay(tokens[i + 2]);
    hour = parseHour(tokens[i + 3]);
    minute = parseMinute(tokens[i + 4]);
    second = parseSecond(tokens[i + 5]);

    // I require a valid year, month and day
    // before parsing a date from this path.
    if (year === false || month === false || day === false) {
      continue;
    }

    var numberOfValidTokens = 3;

    // The path only encodes a time of day when it has a valid hour token.
    hasTime = hour !== false;

    if (hour !== false) numberOfValidTokens++;
    if (hour !== false && minute !== false) numberOfValidTokens++;
    if (hour !== false && minute !== false && second !== false)
      numberOfValidTokens++;

    // only care about minute if hour is valid
    // only care about second  if hour and minute are valid
    // The hour, minute and second are not
    // 100% neccessary IMO so I default to midnight
    second = (hour !== false && minute !== false && second) || 0;
    minute = (hour !== false && minute) || 0;
    hour = hour || 0;

    var composed = [
      year,
      pad(month),
      pad(day),
      pad(hour),
      pad(minute),
      pad(second),
    ].join("-");

    parsed = moment.utc(composed, ["YYYY-MM-DD-HH-mm-ss"]);

    // We found a valid date
    if (parsed.isValid()) {
      created = parsed;

      var invalidTokens = tokens.slice(i + numberOfValidTokens);
      var lengthOfInvalidTokens =
        invalidTokens.join("").length + invalidTokens.length;
      var pathOfInvalidTokens = path.slice(-lengthOfInvalidTokens);

      // Try to separate the numbers which are part of the date
      // from the file name. This is used later to generate titles aautomatically.
      fileName = pathOfInvalidTokens.trim();

      if (fileName.lastIndexOf("/") !== -1)
        fileName = fileName.slice(fileName.lastIndexOf("/") + 1);

      if (fileName.slice(0, 1) === "-" || fileName.slice(0, 1) === "_")
        fileName = fileName.slice(1);

      break;
    }
  }

  return (
    created !== undefined && {
      created: created.valueOf(),
      fileName: fileName,
      hasTime: hasTime,
    }
  );
}

function parseYear(token) {
  return (
    token !== false &&
    token !== null &&
    token !== undefined &&
    token.length === 4 &&
    !isNaN(parseInt(token)) &&
    parseInt(token)
  ); // this is returned
}

function parseMonth(token) {
  return within(parseTime(token), 1, 12);
}

function parseDay(token) {
  return within(parseTime(token), 1, 31);
}

function parseHour(token) {
  return within(parseTime(token), 0, 24);
}

function parseMinute(token) {
  return within(parseTime(token), 0, 60);
}

function parseSecond(token) {
  return parseMinute(token);
}

function within(num, min, max) {
  return (
    num !== false &&
    num !== undefined &&
    num !== null &&
    num >= min &&
    num <= max &&
    num
  ); // the last value is returned
}

function parseTime(token) {
  return (
    token !== false &&
    token !== undefined &&
    token !== null &&
    token.length &&
    token.length < 3 &&
    !isNaN(parseInt(token)) &&
    parseInt(token)
  ); // the last value is returned
}

function pad(number) {
  number = number.toString();

  if (number.length === 1) number = "0" + number;

  return number;
}

module.exports = fromPath;
