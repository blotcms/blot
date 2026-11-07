var Entry = require("models/entry");
var getBlog = require("./blog");
var parseUrl = require("url").parse;

// Takes a URL and fetches the blog, user and entry

// Resolves { user, blog, entry }. When the blog exists but has no such entry,
// entry is undefined and the user and blog are still returned. Throws if
// there is no such blog or user.
async function find(url) {
  var found = await getBlog(url);

  url = parseUrl(url);

  // getByUrl fails otherwise. This is probably a flaw?
  url.path = decodeURIComponent(url.path);

  // Lookup errors have always been ignored here, so they count as no entry
  var entryFromPermalink = await Entry.getByUrl(found.blog.id, url.path).catch(
    () => undefined
  );
  var entryFromPath = await Entry.get(found.blog.id, url.path).catch(
    () => undefined
  );

  if (!entryFromPermalink && !entryFromPath)
    return { user: found.user, blog: found.blog, entry: undefined };

  return {
    user: found.user,
    blog: found.blog,
    entry: entryFromPermalink || entryFromPath,
  };
}

module.exports = find;
