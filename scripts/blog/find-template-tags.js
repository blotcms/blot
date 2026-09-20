// Lists the posts and pages in a blog's folder whose source contains
// Mustache-style template tags (e.g. {{entry.metadata.title}}), plus the
// owner's email address.
//
// Blot no longer renders tags written inside entry content (see #1871), so
// these files now display the raw tags. Read-only: this does not generate an
// access token (unlike scripts/get/blog.js) or modify anything.
//
// If no handle/domain/id is passed, every blog is searched (via each/blog.js,
// with its progress display) and the results are aggregated (only blogs with matches are listed).
//
// Usage: node scripts/blog/find-template-tags.js [handle|domain|id] [--json]

const fs = require("fs-extra");
const getBlog = require("../get/blog");
const eachBlog = require("../each/blog");
const progress = require("../each/progress");
const Entries = require("models/entries");
const Entry = require("models/entry");
const localPath = require("helper/localPath");

const TAG = /\{\{[\s\S]*?\}\}\}?/g;
const MAX_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = /\.(md|markdown|txt|text|html?|org|rtf|docx?|odt)$/i;

const identifier = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const asJSON = process.argv.includes("--json");

function getAllIDs(blogID) {
  return new Promise((resolve, reject) =>
    Entries.getAllIDs(blogID, (err, ids) => (err ? reject(err) : resolve(ids)))
  );
}

function getEntry(blogID, path) {
  return new Promise((resolve) => Entry.get(blogID, path, resolve));
}

// Lists the blog's entry paths (just strings), then handles them one at a
// time. A full entry (content included) is only loaded for files that
// actually contain tags, so memory stays flat however large the site is.
async function scan(blog) {
  const files = [];
  const paths = await getAllIDs(blog.id);
  const bar = progress.push("Entry", paths.length);

  for (const path of paths) {
    bar.tick();
    if (!TEXT_EXTENSIONS.test(path)) continue;

    let tags;
    try {
      const file = localPath(blog.id, path);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      tags = (await fs.readFile(file, "utf8")).match(TAG);
    } catch (e) {
      continue;
    }

    if (!tags) continue;

    const entry = await getEntry(blog.id, path);
    if (!entry || entry.deleted) continue;

    files.push({
      path: entry.path,
      url: entry.url,
      kind: entry.page ? "page" : "post",
      published: !entry.draft && !entry.scheduled,
      tagCount: tags.length,
      tags: Array.from(new Set(tags)).slice(0, 10),
    });
  }

  bar.pop();
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
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
  getBlog(identifier, function (err, user, blog) {
    if (err || !blog) {
      console.error("No blog found for " + identifier);
      return process.exit(1);
    }

    scan(blog).then(function (files) {
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
}

// each/blog.js supplies the sticky blog/entry progress display.
function searchAll() {
  const results = [];
  let searched = 0;

  eachBlog(
    function (user, blog, next) {
      scan(blog)
        .then(function (files) {
          searched++;
          if (files.length) results.push(describe(blog, user, files));
        })
        .catch(function (err) {
          console.error("Error scanning blog " + blog.id + ": " + err.message);
        })
        .then(() => next());
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
      console.log("Searched " + searched + " blog(s)");
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
}

if (identifier) searchOne();
else searchAll();
