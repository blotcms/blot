// Helpers shared by request-time link rewriting (html.js, css.js) and the
// build-time folderAssets plugin, so the two can't drift apart.
const htmlExtRegex = /\.html$/;
const fileExtRegex = /[^/]*\.[^/]*$/;

const parseSrcset = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const candidates = value.split(",");
  const parsed = [];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    const parts = trimmed.split(/\s+/);
    const url = parts.shift();
    if (!url) {
      return null;
    }

    parsed.push({
      url,
      descriptor: parts.length ? parts.join(" ") : "",
    });
  }

  return parsed;
};

// Folder URLs (%%BLOT_CDN%%/folder/v-<version>/<blogID><path>) are built
// from the decoded, case-corrected path on disk, so percent-encode each
// segment: a literal space would split a srcset candidate (or an unquoted
// CSS url()) in two, and a literal '%', '#' or '?' would be misread by the
// browser or the CDN route. unwrapFolderLink.js decodes it again.
const encodeFolderPath = (path) =>
  path.split("/").map(encodeURIComponent).join("/");

module.exports = { htmlExtRegex, fileExtRegex, parseSrcset, encodeFolderPath };
