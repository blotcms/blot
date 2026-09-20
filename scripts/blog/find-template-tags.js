// Lists the posts and pages in a blog's folder whose source contains
// Mustache-style template tags (e.g. {{entry.metadata.title}}), plus the
// owner's email address.
//
// Blot no longer renders tags written inside entry content (see #1871), so
// these files now display the raw tags. Read-only: this does not generate an
// access token (unlike scripts/get/blog.js) or modify anything.
//
// If no handle/domain/id is passed, every blog in series is searched and the
// results are aggregated (only blogs with matches are listed).
//
// Usage: node scripts/blog/find-template-tags.js [handle|domain|id] [--json]

const fs = require("fs-extra");
const async = require("async");
const parseUrl = require("url").parse;
const Blog = require("models/blog");
const User = require("models/user");
const Entries = require("models/entries");
const localPath = require("helper/localPath");

const TAG = /\{\{[\s\S]*?\}\}\}?/g;
const MAX_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = /\.(md|markdown|txt|text|html?|org|rtf|docx?|odt)$/i;

const identifier = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const asJSON = process.argv.includes("--json");

function hostOf(value) {
  try {
    const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
      ? value
      : "https://" + value;
    return parseUrl(withProtocol.toLowerCase()).host || value.toLowerCase();
  } catch (e) {
    return value.toLowerCase();
  }
}

function getBlog(callback) {
  Blog.get({ id: identifier }, function (err, byID) {
    if (byID) return callback(null, byID);
    Blog.get({ handle: identifier }, function (err, byHandle) {
      if (byHandle) return callback(null, byHandle);
      Blog.get({ domain: hostOf(identifier) }, function (err, byDomain) {
        if (byDomain) return callback(null, byDomain);
        callback(new Error("No blog found for " + identifier));
      });
    });
  });
}

function scan(blog, callback) {
  const files = [];

  Entries.each(
    blog.id,
    function (entry, next) {
      if (entry.deleted || !TEXT_EXTENSIONS.test(entry.path)) return next();

      const path = localPath(blog.id, entry.path);

      fs.stat(path, function (err, stat) {
        if (err || !stat.isFile() || stat.size > MAX_BYTES) return next();

        fs.readFile(path, "utf8", function (err, contents) {
          if (err) return next();

          const tags = contents.match(TAG);
          if (!tags) return next();

          files.push({
            path: entry.path,
            url: entry.url,
            kind: entry.page ? "page" : "post",
            published: !entry.draft && !entry.scheduled,
            tagCount: tags.length,
            tags: Array.from(new Set(tags)).slice(0, 10),
          });
          next();
        });
      });
    },
    function () {
      files.sort((a, b) => a.path.localeCompare(b.path));
      callback(files);
    }
  );
}

function describe(blog, user, files) {
  return {
    email: user && user.email,
    blogID: blog.id,
    handle: blog.handle,
    domain: blog.domain,
    files,
  };
}

function printFiles(files) {
  files.forEach(function (file) {
    console.log("");
    console.log(
      file.path +
        "  [" +
        file.kind +
        (file.published ? "" : ", unpublished") +
        (file.url ? ", " + file.url : "") +
        ", " +
        file.tagCount +
        " tag(s)]"
    );
    console.log("  " + file.tags.join("  "));
  });
}

function searchOne() {
  getBlog(function (err, blog) {
    if (err) {
      console.error(err.message);
      return process.exit(1);
    }

    User.getById(blog.owner, function (err, user) {
      scan(blog, function (files) {
        const result = describe(blog, user, files);

        if (asJSON) {
          console.log(JSON.stringify(result, null, 2));
          return process.exit();
        }

        console.log("email:  " + (result.email || "(unknown)"));
        console.log("blog:   " + blog.id + " " + (blog.handle || ""));
        console.log("domain: " + (blog.domain || "(none)"));
        console.log("");
        console.log(files.length + " file(s) with template tags in their source");
        printFiles(files);

        process.exit();
      });
    });
  });
}

function searchAll() {
  Blog.getAllIDs(function (err, blogIDs) {
    if (err || !blogIDs) {
      console.error((err && err.message) || "No blogs found");
      return process.exit(1);
    }

    // Progress goes to stderr so --json output on stdout stays parseable.
    console.error(
      "Searching " + blogIDs.length + " blog(s) in series for template tags..."
    );

    const results = [];
    let searched = 0;

    async.eachSeries(
      blogIDs,
      function (blogID, next) {
        Blog.get({ id: blogID }, function (err, blog) {
          if (err || !blog) return next();

          User.getById(blog.owner, function (err, user) {
            scan(blog, function (files) {
              searched++;
              if (files.length) results.push(describe(blog, user, files));
              if (searched % 100 === 0)
                console.error("  " + searched + "/" + blogIDs.length + " searched");
              next();
            });
          });
        });
      },
      function () {
        const totalFiles = results.reduce((n, r) => n + r.files.length, 0);
        const summary = {
          blogsSearched: searched,
          blogsWithTags: results.length,
          filesWithTags: totalFiles,
        };

        if (asJSON) {
          console.log(JSON.stringify({ summary, blogs: results }, null, 2));
          return process.exit();
        }

        console.log("");
        console.log("Searched " + searched + " of " + blogIDs.length + " blog(s)");
        console.log(
          totalFiles +
            " file(s) with template tags across " +
            results.length +
            " blog(s)"
        );

        results.forEach(function (result) {
          console.log("");
          console.log("=".repeat(60));
          console.log("email:  " + (result.email || "(unknown)"));
          console.log("blog:   " + result.blogID + " " + (result.handle || ""));
          console.log("domain: " + (result.domain || "(none)"));
          printFiles(result.files);
        });

        process.exit();
      }
    );
  });
}

if (identifier) searchOne();
else searchAll();
