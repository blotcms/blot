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
//        [-s START] [-e END] [-r]
//
// -s/-e/-r only apply when searching every blog: start at the Nth blog, end at
// the Nth blog (1-based positions in the list), or reverse the order.

const getBlog = require("../get/blog");
const eachBlog = require("../each/blog");
const progress = require("../each/progress");
const Entries = require("models/entries");
const Entry = require("models/entry");
const folder = require("storage/folder");
const { relative } = require("path");

const TAG = /\{\{[\s\S]*?\}\}\}?/g;
// {{more}} marks the end of a teaser (see app/build/prepare/teaser.js) and is
// not a template tag, so it is not reported.
const MORE = /^\{\{more\}\}$/i;
const MAX_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = /\.(md|markdown|txt|text|html?|org|rtf)$/i;

const args = process.argv.slice(2);
const options = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-s" || args[i] === "-e") options[args[i][1]] = args[++i];
  else if (args[i] === "-r") options.r = true;
  else if (!args[i].startsWith("-")) positional.push(args[i]);
}

const identifier = positional[0];
const asJSON = process.argv.includes("--json");

function getEntry(blogID, path) {
  return new Promise((resolve) => Entry.get(blogID, path, resolve));
}

// Lists the blog's entry paths (just strings), then handles them one at a
// time. A full entry (content included) is only loaded for files that
// actually contain tags, so memory stays flat however large the site is.
async function scan(blog) {
  const files = [];
  const paths = await Entries.getAllIDs(blog.id);
  const bar = progress.push("Entry", paths.length);

  for (const path of paths) {
    bar.tick();
    if (!TEXT_EXTENSIONS.test(path)) continue;

    let tags;
    try {
      const stat = await folder.stat(blog.id, path);
      if (stat.isDirectory || stat.size > MAX_BYTES) continue;
      const buffer = await folder.read(blog.id, path);
      // A NUL byte means binary data, not text, whatever the extension.
      if (buffer.includes(0)) continue;
      tags = buffer.toString("utf8").match(TAG);
    } catch (e) {
      continue;
    }

    if (tags) tags = tags.filter((tag) => !MORE.test(tag));
    if (!tags || !tags.length) continue;

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

function summarise(blog, user, files) {
  return {
    email: user && user.email,
    blogID: blog.id,
    handle: blog.handle,
    domain: blog.domain,
    files,
  };
}

// The path is only printed, for the operator to cat, so this is the one place
// which still names the file on the local disk.
// Double-quoted for the shell, so escape the characters it treats specially.
async function catCommand(blogID, path) {
  const file = relative(process.cwd(), await folder.path(blogID, path));
  return 'cat "' + file.replace(/(["\\$`])/g, "\\$1") + '"';
}

async function printFiles(blogID, files) {
  for (const file of files) {
    console.log("  " + (await catCommand(blogID, file.path)));
  }
}

async function printResult(result) {
  console.log("blog:   " + result.blogID);
  await printFiles(result.blogID, result.files);
}

// Resolves to { user, blog }, or to undefined when the lookup fails
function lookupBlog(identifier) {
  return new Promise((resolve) => {
    getBlog(identifier, (err, user, blog) =>
      resolve(err ? undefined : { user, blog })
    );
  });
}

async function searchOne() {
  const found = await lookupBlog(identifier);

  if (!found || !found.blog) {
    console.error("No blog found for " + identifier);
    return process.exit(1);
  }

  const { user, blog } = found;
  const files = await scan(blog);
  const result = summarise(blog, user, files);

  if (asJSON) {
    console.log(JSON.stringify(result, null, 2));
    return process.exit();
  }

  console.log("email:  " + (result.email || "(unknown)"));
  console.log("blog:   " + blog.id + " " + (blog.handle || ""));
  console.log("domain: " + (blog.domain || "(none)"));
  console.log("");
  console.log(files.length + " file(s) with template tags in their source");
  await printFiles(blog.id, files);

  process.exit();
}

// each/blog.js supplies the sticky blog/entry progress display.
function searchAll() {
  const results = [];
  let searched = 0;

  eachBlog(
    function (user, blog, next) {
      scan(blog)
        .then(async function (files) {
          searched++;
          if (!files.length) return;

          const result = summarise(blog, user, files);
          results.push(result);

          // Report matches as they are found (kept off stdout for --json).
          if (!asJSON) await printResult(result);
        })
        .catch(function (err) {
          console.error("Error scanning blog " + blog.id + ": " + err.message);
        })
        .then(() => next());
    },
    async function () {
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

      for (const result of results) await printResult(result);

      process.exit();
    },
    options
  );
}

if (identifier) {
  searchOne().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else searchAll();
