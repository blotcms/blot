// Lists the posts and pages in a blog's folder whose source contains
// Mustache-style template tags (e.g. {{entry.metadata.title}}), plus the
// owner's email address.
//
// Blot no longer renders tags written inside entry content (see #1871), so
// these files now display the raw tags. Read-only: this does not generate an
// access token (unlike scripts/get/blog.js) or modify anything.
//
// Usage: node scripts/blog/find-template-tags.js <handle|domain|id> [--json]

const fs = require("fs-extra");
const parseUrl = require("url").parse;
const Blog = require("models/blog");
const User = require("models/user");
const Entries = require("models/entries");
const localPath = require("helper/localPath");

const TAG = /\{\{[\s\S]*?\}\}\}?/g;
const MAX_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = /\.(md|markdown|txt|text|html?|org|rtf|docx?|odt)$/i;

const identifier = process.argv[2];
const asJSON = process.argv.includes("--json");

if (!identifier) {
  console.error("Usage: node scripts/blog/find-template-tags.js <handle|domain|id> [--json]");
  process.exit(1);
}

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

getBlog(function (err, blog) {
  if (err) {
    console.error(err.message);
    return process.exit(1);
  }

  User.getById(blog.owner, function (err, user) {
    scan(blog, function (files) {
      const result = {
        email: user && user.email,
        blogID: blog.id,
        handle: blog.handle,
        domain: blog.domain,
        files,
      };

      if (asJSON) {
        console.log(JSON.stringify(result, null, 2));
        return process.exit();
      }

      console.log("email:  " + (result.email || "(unknown)"));
      console.log("blog:   " + blog.id + " " + (blog.handle || ""));
      console.log("domain: " + (blog.domain || "(none)"));
      console.log("");
      console.log(files.length + " file(s) with template tags in their source");

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

      process.exit();
    });
  });
});
