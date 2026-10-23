// Lists the blogs with entries whose stored metadata still holds a build-time
// baked folder link (%%BLOT_CDN%%/folder/v-<hash>/<blogID>/...), written by
// the metadata baking removed in this change. Templates which build a URL from
// a metadata value (…/cdn-cgi/image/width=600{{{metadata.image}}}) break on
// those values. Rebuilding the blog writes the plain path back.
//
// Read-only. Only metadata is checked: baked links in an entry's html, body
// and teaser are expected, and stay baked.
//
// Usage: node scripts/blog/find-baked-metadata.js [handle|domain|id]
//        [--paths] [--json] [-s START] [-e END] [-r]
//
// With no handle every blog is searched (via each/blog.js, with its progress
// display) and only blogs with matches are listed. --paths also lists each
// entry's path and the metadata keys. -s/-e/-r only apply when searching every
// blog: start at the Nth blog, end at the Nth blog, or reverse the order.
//
// Rebuild a listed blog with: node scripts/blog/rebuild/index.js <handle>

const getBlog = require("../get/blog");
const eachBlog = require("../each/blog");
const Entries = require("models/entries");
const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");

const args = process.argv.slice(2);
const options = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-s" || args[i] === "-e") options[args[i][1]] = args[++i];
  else if (args[i] === "-r") options.r = true;
  else if (!args[i].startsWith("-")) positional.push(args[i]);
}

const identifier = positional[0];
const asJSON = args.includes("--json");
const listPaths = args.includes("--paths");

function scan(blog) {
  const matches = [];

  return new Promise((resolve, reject) =>
    Entries.each(
      blog.id,
      function (entry, next) {
        const metadata = entry.metadata || {};
        const keys = Object.keys(metadata).filter(
          (key) =>
            typeof metadata[key] === "string" &&
            metadata[key].indexOf(BLOT_CDN_TOKEN) > -1
        );

        if (!entry.deleted && keys.length) {
          matches.push({ path: entry.path, keys });
        }

        setImmediate(next);
      },
      (err) => (err ? reject(err) : resolve(matches))
    )
  );
}

function summarise(user, blog, entries) {
  return {
    email: user && user.email,
    blogID: blog.id,
    handle: blog.handle,
    domain: blog.domain,
    entries,
  };
}

function printResult(result) {
  console.log(
    result.blogID +
      " " +
      (result.handle || "") +
      " " +
      (result.domain || "") +
      " " +
      result.entries.length +
      " entr" +
      (result.entries.length === 1 ? "y" : "ies")
  );

  if (listPaths) {
    result.entries.forEach((entry) =>
      console.log("  " + entry.path + " (" + entry.keys.join(", ") + ")")
    );
  }
}

function searchOne() {
  getBlog(identifier, function (err, user, blog) {
    if (err || !blog) {
      console.error("No blog found for " + identifier);
      return process.exit(1);
    }

    scan(blog).then(
      function (entries) {
        const result = summarise(user, blog, entries);

        if (asJSON) console.log(JSON.stringify(result, null, 2));
        else printResult(result);

        process.exit();
      },
      function (err) {
        console.error(err);
        process.exit(1);
      }
    );
  });
}

function searchAll() {
  const results = [];
  let searched = 0;
  let errors = 0;

  eachBlog(
    function (user, blog, next) {
      scan(blog)
        .then(function (entries) {
          searched++;
          if (!entries.length) return;

          const result = summarise(user, blog, entries);
          results.push(result);

          // Report matches as they are found (kept off stdout for --json).
          if (!asJSON) printResult(result);
        })
        .catch(function (err) {
          errors++;
          console.error("Error scanning blog " + blog.id + ": " + err.message);
        })
        .then(() => next());
    },
    function () {
      const total = results.reduce((n, r) => n + r.entries.length, 0);

      if (asJSON) {
        console.log(
          JSON.stringify(
            {
              summary: { blogsSearched: searched, blogsWithBakedMetadata: results.length, entries: total, errors },
              blogs: results,
            },
            null,
            2
          )
        );
        return process.exit(errors ? 1 : 0);
      }

      console.log("");
      console.log(
        "Searched " + searched + " blog(s): " + total + " entr" + (total === 1 ? "y" : "ies") +
          " with baked metadata across " + results.length + " blog(s)" +
          (errors ? ", " + errors + " blog(s) failed" : "")
      );

      process.exit(errors ? 1 : 0);
    },
    options
  );
}

if (identifier) searchOne();
else searchAll();
