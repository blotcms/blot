// A redirect target from a form, kept on this site: a path starting with a
// single "/" (not "//" or "/\", which browsers treat as another host), or an
// absolute URL on the dashboard's own host (the template editor's base).
// Anything else gives the fallback.
module.exports = function safeRedirect(target, fallback, host) {
  if (typeof target !== "string") return fallback;

  if (
    target.startsWith("/") &&
    !target.startsWith("//") &&
    !target.startsWith("/\\")
  ) {
    return target;
  }

  if (host && /^https?:\/\//i.test(target)) {
    try {
      if (new URL(target).hostname === host) return target;
    } catch (e) {
      // not a URL
    }
  }

  return fallback;
};
