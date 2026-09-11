// The "+" source folder a stored folder-post entry was built from, read off
// the data-folder attribute in its generated HTML. Returns null when the
// entry is not a folder post.
module.exports = function folderPostSourceFolder(entry) {
  var html = entry && entry.html;

  if (typeof html !== "string") return null;
  if (html.indexOf('class="multi-file-post"') === -1) return null;

  var match = html.match(
    /<section class="multi-file-post"[^>]*\sdata-folder="([^"]*)"/
  );

  if (!match) return null;

  return String(match[1])
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
};
