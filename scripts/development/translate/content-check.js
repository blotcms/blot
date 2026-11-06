// Report what content a site actually has, and exit non-zero when there is
// nothing worth templating. Runs INSIDE the container.
//
//   docker exec blot-node-app-1 node scripts/development/translate/content-check <blogID>
//
// Files on disk are not the question — the folder watcher is asynchronous, so a
// copy can be complete while entries have not been built yet. This checks the
// database.

const { promisify } = require("util");
const moment = require("moment");

const Blog = require("models/blog");
const Entries = require("models/entries");
const Entry = require("models/entry");
const Tags = require("models/tags");

const getBlog = promisify(Blog.get);
const getListIDs = promisify(Entries.getListIDs);
const listTags = promisify(Tags.list);

const emit = (key, value) => console.log(`${key}=${value}`);

// Blot maintains a Redis list per category, so we can count directly rather
// than pulling every entry and filtering. Note `all` includes deleted entries
// and `getAllIDs` returns soft-deleted paths too — neither is what we want.
const LISTS = ["entries", "pages", "drafts", "scheduled"];

async function countLists(blogID) {
  const counts = {};

  for (const list of LISTS) {
    const ids = await getListIDs(blogID, list, {});
    counts[list] = (ids || []).length;
  }

  return counts;
}

// A post's date comes from its metadata (`Date:`) or its path (2024/03-12-name).
// With neither, build/prepare/dateStamp returns undefined and models/entry/set.js
// falls back to `entry.created` — the moment the file was added to Blot, *not*
// the file's modification time. So a folder whose content carries no dates gets
// "today" for every post no matter how carefully it was copied, which quietly
// ruins archives, feeds and any date display in the template.
const CLUSTER_WINDOW = 60 * 60 * 1000; // 1 hour
const RECENT_WINDOW = 24 * 60 * 60 * 1000; // 1 day

function looksLikeMissingDates(stamps) {
  if (stamps.length < 2) return false;

  const newest = Math.max(...stamps);
  const oldest = Math.min(...stamps);

  return (
    newest - oldest < CLUSTER_WINDOW && Date.now() - newest < RECENT_WINDOW
  );
}

async function dateRange(blogID) {
  // The `entries` list is scored by dateStamp, so the ends of it are the range.
  const ids = await getListIDs(blogID, "entries", {});

  if (!ids || !ids.length) return null;

  const stamps = [];

  for (const id of ids) {
    const entry = await getEntry(blogID, id);
    if (entry && entry.dateStamp) stamps.push(entry.dateStamp);
  }

  if (!stamps.length) return null;

  return {
    from: moment(Math.min(...stamps)).format("YYYY-MM-DD"),
    to: moment(Math.max(...stamps)).format("YYYY-MM-DD"),
    suspicious: looksLikeMissingDates(stamps),
  };
}

// Entry.get calls back with (entry) — no error argument.
function getEntry(blogID, path) {
  return new Promise((resolve) => Entry.get(blogID, path, resolve));
}

async function countTags(blogID) {
  try {
    const tags = await listTags(blogID);
    return Array.isArray(tags) ? tags.length : Object.keys(tags || {}).length;
  } catch (e) {
    return 0;
  }
}

function describer(counts, tags, range) {
  const parts = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  parts.push(plural(counts.entries, "post"));
  if (counts.pages) parts.push(plural(counts.pages, "page"));
  if (counts.drafts) parts.push(plural(counts.drafts, "draft"));
  if (counts.scheduled) parts.push(plural(counts.scheduled, "scheduled post"));
  if (tags) parts.push(plural(tags, "tag"));

  let summary = parts.join(", ");

  if (range) {
    summary +=
      range.from === range.to
        ? ` (${range.from})`
        : ` (${range.from} to ${range.to})`;
  }

  return summary;
}

async function main(blogID) {
  if (!blogID) throw new Error("Pass a blog ID as the first argument");

  const blog = await getBlog({ id: blogID });

  if (!blog || !blog.id) throw new Error(`No blog with ID ${blogID}`);

  const counts = await countLists(blogID);
  const tags = await countTags(blogID);
  const range = await dateRange(blogID);

  // Pages alone are a legitimate site (a portfolio, a single landing page), so
  // the gate is "anything publishable", not "at least one post".
  const publishable = counts.entries + counts.pages;

  emit("posts", counts.entries);
  emit("pages", counts.pages);
  emit("drafts", counts.drafts);
  emit("scheduled", counts.scheduled);
  emit("tags", tags);
  emit("publishable", publishable);
  emit("cacheID", blog.cacheID || 0);
  emit("summary", publishable ? describer(counts, tags, range) : "no content");

  if (range && range.suspicious) {
    emit(
      "warning",
      "every post has today's date. None of this content carries a date, so Blot " +
        "is falling back to when each file was added. Give posts a 'Date:' line " +
        "in their metadata, or a dated path like 2024/03-12-name.txt, if dates " +
        "matter to the design. (Note this is not about file timestamps — Blot " +
        "does not use mtime for the publication date.)"
    );
  }

  return publishable > 0;
}

if (require.main === module) {
  main(process.argv[2])
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err) => {
      console.error("[content-check]", err.message);
      process.exit(2);
    });
}

module.exports = main;
