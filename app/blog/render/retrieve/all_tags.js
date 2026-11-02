const Tags = require("models/tags");
const asRetriever = require("../../lib/asRetriever");

// Every tag, from Tags.getCachedList, which caches the list per blog cacheID
// and path prefix (previews share it: nothing in it depends on the
// template). The sorting and counting here are cheap next to the list read.
async function allTags(req, res) {
  const path_prefix =
    res.locals.path_prefix ??
    (req.template && req.template.locals && req.template.locals.path_prefix);

  req.log("Listing all tags");
  let tags = await Tags.getCachedList(req.blog.id, {
    pathPrefix: path_prefix,
    cacheID: req.blog.cacheID,
    log: req.log,
  });

  // In future, we might want to expose
  // other options for this sorting...
  req.log("Sorting all tags");
  tags = tags.sort(function (a, b) {
    const nameA = a.name.toLowerCase();
    const nameB = b.name.toLowerCase();

    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    return 0;
  });

  const set = {};

  req.log("Counting all tags");
  tags = tags.map((tag) => {
    tag.tag = tag.name;
    tag.total = tag.entries.length;
    tag.entries.forEach((id) => {
      set[id] = true;
    });
    if (tag.slug) tag.slug = encodeURIComponent(tag.slug);
    return tag;
  });

  // toDO maybe rename this? it's ugly
  res.locals.all_tags_total_posts = Object.keys(set).length;
  req.log("Listed all tags");

  return tags;
}

module.exports = asRetriever(allTags);
