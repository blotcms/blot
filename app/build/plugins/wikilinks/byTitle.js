const makeSlug = require("helper/makeSlug");

// Entries are read in full (models/entry/get.js), so only this many are held
// at once while the titles are collected.
const BATCH_SIZE = 25;

// Resolves the title, url and path of every post, then every page, newest
// first. Reading every entry in full for each [[Title]] link, concurrently,
// held one copy of the whole blog per link: a post with four title links on
// a blog of ~660 entries loaded 96MB and crashed the container it was built
// in (V8 heap out of memory, Oct 2026). Keeping only what a link needs, a
// batch at a time, bounds the heap at one batch.
async function loadTitles(blogID) {
  // there is a circular dependency loop between the entries
  // model and build so this is neccessary for now...
  const { getListIDs } = require("models/entries");
  const getEntries = require("models/entry").get;
  const titles = [];

  for (const list of ["entries", "pages"]) {
    const ids = await new Promise((resolve, reject) =>
      getListIDs(blogID, list, {}, (err, ids) => (err ? reject(err) : resolve(ids)))
    );

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const entries = await new Promise((resolve, reject) =>
        getEntries(blogID, ids.slice(i, i + BATCH_SIZE), (entries, err) =>
          err ? reject(err) : resolve(entries)
        )
      );

      for (const { title, url, path } of entries) titles.push({ title, url, path });
    }
  }

  return titles;
}

// A render's links share one read of the titles: call this once per render
// and pass the result to byTitle for each link. The read starts on the first
// title lookup, so a post whose links all resolve another way never makes it.
function titleIndex(blogID) {
  let titles;
  return () => (titles = titles || loadTitles(blogID));
}

function byTitle(titles, href, done) {
  titles().then(
    function (allEntries) {
      const perfectMatch = allEntries.find((entry) => entry.title === href);

      if (perfectMatch) {
        return done(null, {
          url: perfectMatch.url,
          title: perfectMatch.title,
          path: perfectMatch.path,
        });
      }

      // Will trim, lowercase, remove punctuation, etc.
      const slug = makeSlug(href);
      const roughMatch = allEntries.find((entry) => makeSlug(entry.title) === slug);

      if (roughMatch) {
        return done(null, {
          url: roughMatch.url,
          title: roughMatch.title,
          path: roughMatch.path,
        });
      }

      done(new Error("No entry found by title with href: " + href));
    },
    function (err) {
      done(err);
    }
  );
}

module.exports = byTitle;
module.exports.titleIndex = titleIndex;
