// Given a Cache-Control header value (and optionally the response's Age
// header), return an absolute expiry timestamp in ms, or null if the
// response cannot be reused without revalidation.
function expire(str, ageSeconds) {
  var now = Date.now();

  if (!str) return null;

  // no-cache / no-store require revalidation before every reuse, so a
  // co-present max-age must NOT be turned into a future expiry that lets
  // isFresh() skip the request. (must-revalidate is different - it only
  // applies once the entry is already stale - so it is not matched here.)
  if (/(?:^|[,\s])no-(?:cache|store)(?:[,\s]|$)/i.test(str)) return null;

  // Pull the delta-seconds out of the header, e.g.
  // "public, max-age=600, immutable" -> 600. The previous implementation
  // sliced to the start of "max-age=" but never past it, so parseInt
  // always saw "max-age=..." and returned NaN - meaning max-age was
  // silently ignored and such responses were re-downloaded every build.
  var match = /(?:^|[,\s])max-age\s*=\s*"?(\d+)"?/i.exec(str);

  if (!match) return null;

  var seconds = parseInt(match[1], 10);

  if (isNaN(seconds)) return null;

  // A response relayed by a CDN/proxy may already be part-way through its
  // life; Age tells us how far. Charge that against max-age so we don't
  // restart the freshness lifetime on every hop.
  var age = parseInt(ageSeconds, 10);

  if (isNaN(age) || age < 0) age = 0;

  var remaining = seconds - age;

  if (remaining <= 0) return null;

  return now + remaining * 1000;
}

function date(str) {
  var date = null;

  try {
    date = new Date(str).valueOf();
  } catch (e) {
    date = null;
  }

  if (isNaN(date)) date = null;

  return date;
}

module.exports = {
  date: date,
  expire: expire,
};
