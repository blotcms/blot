const DEFAULT = "/sites";

// Returns the 'then' redirect target if it is a path on this site,
// otherwise the dashboard. Rejects absolute URLs and anything a browser
// reads as another origin: '//evil.com', '/\evil.com', '/%5Cevil.com'.
module.exports = function safeThen(then) {
  if (typeof then !== "string" || !then) return DEFAULT;
  if (then[0] !== "/") return DEFAULT;
  if (then[1] === "/" || then[1] === "\\") return DEFAULT;
  // Browsers drop tabs and newlines from URLs, so '/\t/evil.com' is '//evil.com'
  if (/[\s\\]/.test(then)) return DEFAULT;
  if (/^\/%5c/i.test(then) || /^\/%2f/i.test(then)) return DEFAULT;
  return then;
};
