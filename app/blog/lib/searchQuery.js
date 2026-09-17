// Join repeated ?q= into one string. Non-strings (e.g. ?q[foo]=bar) are
// returned as-is so the search route can 404.
module.exports = function searchQueryString(q) {
  if (Array.isArray(q)) return q.join(" ");
  return q;
};
