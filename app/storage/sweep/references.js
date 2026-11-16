const client = require("models/client");
const Entries = require("models/entries");
const Entry = require("models/entry");
const Template = require("models/template");
const templateKey = require("models/template/key");
const Blog = require("models/blog");

// What the sweep of generated files (./generated, #2688 section 7, #2745)
// treats as in use: images from deleted posts, stale thumbnails, versions of
// photos replaced or edited in place, changed remote images and duplicates
// from concurrent builds are what it removes. This module only reads; the
// deleting, and the two phases that protect a build in progress, are in
// ./generated.
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
// read, so a blog whose references can't all be read fails its step
// instead of counting live files as unreferenced and deleting them.

const SCOPES = ["_image_cache", "_thumbnails", "_bookmark_screenshots"];
const ENTRY_BATCH = 100;
const REFERENCE = new RegExp(
  "/(" + SCOPES.join("|") + ")/([^/\"'\\s?#)\\\\]+)",
  "g"
);

// What mentions "/_assets/<id>", for scripts/storage/assets-of-removed-files.js
// (the sweep never reads it: _assets is not swept)
const ASSET_REFERENCE = new RegExp("/(_assets)/([^/\"'\\s?#)\\\\]+)", "g");

// Every "<scope>/<id>" mentioned in a value, by the pattern, which is the
// sweep's scopes unless another is given
function referencesIn(value, into, pattern) {
  const text = typeof value === "string" ? value : JSON.stringify(value);

  if (!text) return into;

  for (const match of text.matchAll(pattern || REFERENCE))
    into.add(match[1] + "/" + match[2]);

  return into;
}

async function inUse(blogID, pattern) {
  const used = new Set();
  const ids = await Entries.getAllIDs(blogID);

  for (let i = 0; i < ids.length; i += ENTRY_BATCH) {
    for (const entry of await Entry.get(blogID, ids.slice(i, i + ENTRY_BATCH)))
      if (entry && !entry.deleted) referencesIn(entry, used, pattern);
  }

  const blog = await Blog.get({ id: blogID });

  if (!blog) throw new Error("sweep/references: no blog " + blogID);

  referencesIn(blog, used, pattern);

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

    referencesIn(metadata, used, pattern);

    for (const name of await client.sMembers(templateKey.allViews(id))) {
      let view;

      try {
        view = await Template.getView(id, name);
      } catch (err) {
        // A name in the set with no view behind it, not a failed read
        if (/^No view: /.test(err.message)) continue;
        throw err;
      }

      referencesIn(view, used, pattern);
    }
  }

  return used;
}
module.exports = { inUse, referencesIn, SCOPES, ASSET_REFERENCE };
