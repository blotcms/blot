function canonicalize(url) {
  // Split off the query string and/or fragment so their delimiters are treated
  // as structural URL syntax rather than being folded into path-segment
  // encoding. Otherwise a slug containing an encoded "?" (e.g. `foo%3Fbar`)
  // would canonicalize to the same value as a distinct link with a real query
  // string (`foo?bar`).
  var suffixIndex = url.search(/[?#]/);
  var suffix = "";

  if (suffixIndex !== -1) {
    suffix = url.slice(suffixIndex);
    url = url.slice(0, suffixIndex);
  }

  var segments = url.split("/").map(function (segment) {
    return decodeURIComponent(segment);
  });

  // Match the previous behavior, which trimmed after decoding the URL.
  segments[0] = segments[0].trimStart();
  segments[segments.length - 1] = segments[segments.length - 1].trimEnd();

  // Decode and re-encode each path segment independently. In particular, this
  // keeps an encoded slash inside a tag slug rather than turning it into a path
  // separator.
  return segments.map(encodeURIComponent).join("/") + suffix;
}

module.exports = function (req, res, callback) {
  return callback(null, function () {
    var url;
    var link;

    try {
      url = req.url;
      link = this.url;

      if (!link && this.slug) link = "/tagged/" + this.slug;

      url = canonicalize(url);
      link = canonicalize(link);
    } catch (e) {
      return false;
    }

    var active = "";

    if (link === url) active = "active";

    return active;
  });
};
