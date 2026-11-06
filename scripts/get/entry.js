var Entry = require("models/entry");
var blog = require("./blog");
var parseUrl = require("url").parse;

// Takes a URL and fetches the blog, user and entry

// Resolves { err, user, blog, entry }. When the blog exists but has no such
// entry, err is "No entry" and the user and blog are still returned.
async function find(url) {
  var found = await new Promise(function (resolve, reject) {
    blog(url, function (err, user, blog) {
      if (err) return reject(err);
      resolve({ user, blog });
    });
  });

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
    return { err: new Error("No entry"), user: found.user, blog: found.blog };

  return {
    err: null,
    user: found.user,
    blog: found.blog,
    entry: entryFromPermalink || entryFromPath,
  };
}

module.exports = function get(url, callback) {
  find(url).then(
    function (found) {
      callback(found.err, found.user, found.blog, found.entry);
    },
    function (err) {
      callback(err);
    }
  );
};
