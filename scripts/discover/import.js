// Imports posts into Discover (#2639) from a file written by
// scripts/discover/export.js. The maintainer curates Discover locally against
// mirrored copies of real sites, which have the same blog IDs, entry URLs and
// image asset paths as production, then runs this on production.
//
//   node scripts/discover/import.js <file> [--apply]
//
// On production, with the file copied into the unit:
//
//   docker cp discover.json blot-blue:/tmp/discover.json
//   docker exec -u 1000 blot-blue node scripts/discover/import.js /tmp/discover.json
//
// For each post, in the order of the file, it finds the blog by its ID and the
// entry by its URL (not its path, which differs between copies). A post is
// skipped, and counted, when:
//
//   - the blog does not exist ("no blog");
//   - no entry is at the URL, or it is deleted, a draft or scheduled
//     ("no entry");
//   - it is on Discover already ("already there"), so a rerun does nothing.
//
// Of the photos in the file, only the ones still in the entry's HTML (the
// images Discover offers for it) are kept; the others are reported as
// "photos missing". A post which had photos in the file and has none left
// is not imported, rather than become a text card, and is counted as "no
// photos".
//
// With --apply each kept photo is resized (as Discover does when a post is
// added) and the post is added with its original added time, which keeps the
// order. Without it, nothing is written. Safe to rerun: a post already on
// Discover is left as it is, so after an interruption run it again.

const fs = require("fs-extra");
const Blog = require("models/blog");
const Entry = require("models/entry");
const Discover = require("models/discover");

function usage(message) {
  if (message) console.error(message + "\n");

  console.error("Usage: node scripts/discover/import.js <file> [--apply]");
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false, file: null };

  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (!arg.startsWith("--") && !options.file) options.file = arg;
    else usage("Unknown argument: " + arg);
  }

  if (!options.file) usage("Name the file to import");

  return options;
}

// Resolves to the parsed export, or throws if the file isn't one
async function read(file) {
  const data = JSON.parse(await fs.readFile(file, "utf-8"));

  if (!data || data.version !== 1 || !Array.isArray(data.posts))
    throw new Error(file + " is not a version 1 Discover export");

  return data;
}

// A post from a site with "Include site on discover page" off is stored but
// hidden until the site turns it on, so the report says so
function off(blog) {
  return blog.includeInDiscover !== true;
}

// Imports one post of an export. Resolves to { status, missing } where
// status is "imported" (or "would import" without apply), "already",
// "no blog" or "no entry", and missing lists the sources which are no
// longer in the entry.
async function importPost(post, apply) {
  const blog = await Blog.get({ id: post.blogID });

  if (!blog) return { status: "no blog", missing: [] };

  const found = await Entry.getByUrl(post.blogID, post.url);
  const entry = found ? await Entry.get(post.blogID, found.id) : null;

  if (!entry || entry.deleted || entry.draft || entry.scheduled)
    return { status: "no entry", missing: [] };

  if (await Discover.has(post.blogID, entry.id))
    return { status: "already", missing: [] };

  const available = Discover.photos.candidates(post.blogID, entry);
  const sources = post.sources.filter((source) => available.includes(source));
  const missing = post.sources.filter((source) => !available.includes(source));

  if (post.sources.length && !sources.length)
    return { status: "no photos", missing };

  if (!apply)
    return { status: "would import", missing, sources, hidden: off(blog) };

  const photos = await Discover.photos.derive(
    post.blogID,
    Discover.postID(post.blogID, entry.id),
    sources
  );

  await Discover.add(post.blogID, entry.id, photos, { added: post.added });

  return { status: "imported", missing, sources, hidden: off(blog) };
}

// Imports every post of an export, calling report(post, result) after each.
// Resolves to the totals.
async function importPosts(data, apply, report = () => {}) {
  const totals = {
    imported: 0,
    already: 0,
    noBlog: 0,
    noEntry: 0,
    noPhotos: 0,
    photosMissing: 0,
  };

  for (const post of data.posts) {
    const result = await importPost(post, apply);

    if (result.status === "no blog") totals.noBlog++;
    else if (result.status === "no entry") totals.noEntry++;
    else if (result.status === "no photos") totals.noPhotos++;
    else if (result.status === "already") totals.already++;
    else totals.imported++;

    totals.photosMissing += result.missing.length;

    report(post, result);
  }

  return totals;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const data = await read(options.file);

  const totals = await importPosts(data, options.apply, (post, result) => {
    console.log(
      post.blogID +
        " " +
        post.url +
        ": " +
        result.status +
        (result.hidden ? " (hidden: the site has Discover off)" : "") +
        (result.missing.length
          ? ", photos missing: " + result.missing.join(", ")
          : "")
    );
  });

  console.log(
    "Total of " +
      data.posts.length +
      " posts: " +
      (options.apply ? "imported " : "would import ") +
      totals.imported +
      ", already there " +
      totals.already +
      ", no blog " +
      totals.noBlog +
      ", no entry " +
      totals.noEntry +
      ", none of the photos left " +
      totals.noPhotos +
      ", photos missing " +
      totals.photosMissing
  );

  if (!options.apply) console.log("Dry run: pass --apply to import them");
}

if (require.main === module) {
  main().then(
    function () {
      process.exit(0);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
}

module.exports = { read, importPost, importPosts };
