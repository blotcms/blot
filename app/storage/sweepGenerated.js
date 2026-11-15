const s3 = require("storage/s3");
const client = require("models/client");
const Entries = require("models/entries");
const Entry = require("models/entry");
const Template = require("models/template");
const templateKey = require("models/template/key");
const Blog = require("models/blog");

// The sweep of generated files nothing uses any more (#2688, section 7):
// images from deleted posts, stale thumbnails, versions of photos replaced
// or edited in place, changed remote images, duplicates from concurrent
// builds. This is the report-only first run, which measures how much space
// a deleting sweep would free and so sets its grace period; nothing here
// deletes anything.
//
// Generated files sit in the bucket at {blogID}/<scope>/<id>/..., one
// directory per source (an image, a thumbnail set, a converted document),
// and are linked as .../<scope>/<id>/... So a directory is in use when a
// saved entry that isn't deleted (post, page, draft or scheduled), one of
// the blog's own templates, or the blog's settings mention it. The
// dependency graph is no help: generated files are keyed by the source's
// bytes, so it misses the same photo under two names, replaced photos,
// remote images and template images.
//
// Template uploads (_template_assets) and avatars (_avatars) exist nowhere
// else, so they are never candidates. Nor is _assets: a Google Doc imported
// from Drive keeps its images there, linked from the source document in the
// folder rather than from the entry, whose HTML has their _image_cache copies
// instead (clients/google-drive/util/download.js, build/converters/gdoc).
//
// Every read here rejects on a failure rather than skipping what it couldn't
// read, so a blog whose references can't all be read fails its report
// instead of counting live files as unreferenced.

const SCOPES = ["_image_cache", "_thumbnails", "_bookmark_screenshots"];
const ENTRY_BATCH = 100;
const REFERENCE = new RegExp(
  "/(" + SCOPES.join("|") + ")/([^/\"'\\s?#)\\\\]+)",
  "g"
);

const DAY = 24 * 60 * 60 * 1000;

// Every "<scope>/<id>" mentioned in a value
function referencesIn(value, into) {
  const text = typeof value === "string" ? value : JSON.stringify(value);

  if (!text) return into;

  for (const match of text.matchAll(REFERENCE))
    into.add(match[1] + "/" + match[2]);

  return into;
}

async function inUse(blogID) {
  const used = new Set();
  const ids = await Entries.getAllIDs(blogID);

  for (let i = 0; i < ids.length; i += ENTRY_BATCH) {
    for (const entry of await Entry.get(blogID, ids.slice(i, i + ENTRY_BATCH)))
      if (entry && !entry.deleted) referencesIn(entry, used);
  }

  const blog = await Blog.get({ id: blogID });

  if (!blog) throw new Error("sweepGenerated: no blog " + blogID);

  referencesIn(blog, used);

  for (const id of await client.sMembers(templateKey.blogTemplates(blogID))) {
    let metadata;

    try {
      metadata = await Template.getMetadata(id);
    } catch (err) {
      // An ID in the set with no template behind it, not a failed read
      if (err.code === "ENOENT") continue;
      throw err;
    }

    if (metadata.owner !== blogID) continue;

    referencesIn(metadata, used);

    for (const name of await client.sMembers(templateKey.allViews(id))) {
      let view;

      try {
        view = await Template.getView(id, name);
      } catch (err) {
        // A name in the set with no view behind it, not a failed read
        if (/^No view: /.test(err.message)) continue;
        throw err;
      }

      referencesIn(view, used);
    }
  }

  return used;
}

// "<scope>/<id>" -> { files, bytes, newest } for each generated directory
async function stored(blogID) {
  const dirs = new Map();

  for (const scope of SCOPES) {
    const prefix = blogID + "/" + scope + "/";

    for await (const object of s3.listEntries(prefix)) {
      if (!object.key) continue;

      const id = object.key.slice(prefix.length).split("/")[0];

      if (!id) continue;

      const name = scope + "/" + id;
      const dir = dirs.get(name) || { files: 0, bytes: 0, newest: 0 };
      const modified = new Date(object.modified).getTime() || 0;

      dir.files++;
      dir.bytes += object.size || 0;
      dir.newest = Math.max(dir.newest, modified);
      dirs.set(name, dir);
    }
  }

  return dirs;
}

// A blog's totals: { scope: { stored, referenced, unreferenced, oldEnough } }
// in bytes, where oldEnough is the unreferenced bytes whose newest file is
// older than graceDays (what a deleting sweep would remove), and the
// unreferenced directories as a list when listUnreferenced.
async function report(blogID, options = {}) {
  const graceDays = options.graceDays || 60;
  const cutoff = Date.now() - graceDays * DAY;
  const used = await inUse(blogID);
  const dirs = await stored(blogID);
  const totals = {};
  const unreferenced = [];

  for (const scope of SCOPES)
    totals[scope] = { stored: 0, referenced: 0, unreferenced: 0, oldEnough: 0 };

  for (const [name, dir] of dirs) {
    const scope = name.split("/")[0];
    const t = totals[scope];

    t.stored += dir.bytes;

    if (used.has(name)) {
      t.referenced += dir.bytes;
    } else {
      t.unreferenced += dir.bytes;
      if (dir.newest < cutoff) t.oldEnough += dir.bytes;
      if (options.listUnreferenced) unreferenced.push(name);
    }
  }

  return { blogID, totals, unreferenced };
}

module.exports = { report, inUse, stored, referencesIn, SCOPES };
