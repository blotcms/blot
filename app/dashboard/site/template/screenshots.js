// Screenshots of a blog's templates, as rendered with the blog's own posts,
// for the template list and the site overview.
//
// Only the templates that look different on this blog get one: its own
// templates, defaults it has customized (mirrors) and the live template. The
// other defaults keep the gallery images (app/views/images/examples), which
// are screenshots of the same templates on demo content.
//
// Screenshots are taken on demand, in the background, when a page lists the
// template and its stored screenshot is missing or stale: the template changed
// (its cacheID), or the blog's posts changed and the screenshot is more than a
// day old. A busy blog therefore gets at most one new screenshot per template
// a day, however often it syncs. The page shows the previous image (or the
// gallery image) until the new one is ready.
//
// Files live in the blog's asset store under _template_screenshots/, each
// with a new name so the CDN never serves an old image; the file a new
// screenshot replaces is deleted, and entries for templates that no longer
// exist are removed when the list is next shown. The record of which file is
// current is a Redis hash under the blog's keys, so deleting the blog removes
// both (models/blog/remove.js, storage/assets removeAll).

const crypto = require("crypto");
const fs = require("fs-extra");
const sharp = require("sharp");
const client = require("models/client");
const assets = require("storage/assets");
const screenshot = require("helper/screenshot");
const clfdate = require("helper/clfdate");

const DIRECTORY = "_template_screenshots";
const WIDTH = 1060; // the same viewport as the template gallery
const HEIGHT = 780;
const THUMBNAIL_WIDTH = 640; // twice the card's width
const STALE_AFTER = 24 * 60 * 60 * 1000;
// However often a template is saved, it is screenshot at most this often
const MIN_INTERVAL = 10 * 60 * 1000;
const LOCK_SECONDS = 5 * 60;
// Per process. Beyond this, pages show the previous image and ask again later
const MAX_QUEUED = 20;
// After a failed screenshot (a page that times out, say), the template is
// left alone this long, rather than every view of the template list starting
// Chromium again for a page that will likely fail again
const FAILURE_BACKOFF = 30 * 60 * 1000;

const key = (blogID) => "blog:" + blogID + ":template-screenshots";
const lockKey = (blogID, templateID) =>
  "blog:" + blogID + ":template-screenshots:lock:" + templateID;

const log = (...args) =>
  console.log(clfdate(), "Template screenshot:", ...args);

// blogID -> { templateID: { path, templateCacheID, blogCacheID, takenAt,
// failedAt } }. An entry may have only failedAt, when the first screenshot
// failed.
async function load(blogID) {
  const hash = await client.hGetAll(key(blogID));
  const entries = {};
  for (const templateID in hash) {
    try {
      entries[templateID] = JSON.parse(hash[templateID]);
    } catch (e) {}
  }
  return entries;
}

function isStale(entry, template, blog) {
  if (entry && entry.failedAt && Date.now() - entry.failedAt < FAILURE_BACKOFF)
    return false;
  if (!entry || !entry.path) return true;
  if (Date.now() - entry.takenAt < MIN_INTERVAL) return false;
  if (String(entry.templateCacheID) !== String(template.cacheID)) return true;
  return (
    String(entry.blogCacheID) !== String(blog.cacheID) &&
    Date.now() - entry.takenAt > STALE_AFTER
  );
}

// Screenshots run one at a time per process (helper/screenshot paces them);
// this only keeps the same template from being queued twice.
const queued = new Map();
let running = Promise.resolve();

// Returns whether a screenshot of the template is now on its way
function enqueue(blog, template, previous) {
  const id = blog.id + "\0" + template.id;
  if (queued.has(id)) return true;
  if (queued.size >= MAX_QUEUED) return false;
  queued.set(id, true);

  running = running
    .then(() => take(blog, template, previous))
    .catch((err) => log("failed", blog.id, template.id, err.message))
    .finally(() => queued.delete(id));

  return true;
}

async function take(blog, template, previous) {
  // Blue and green both list templates, so the first to ask takes it
  const locked = await client.set(lockKey(blog.id, template.id), "1", {
    NX: true,
    EX: LOCK_SECONDS,
  });
  if (!locked) return;

  const name =
    template.slug.replace(/[^a-z0-9-]/gi, "-") +
    "-" +
    crypto.randomBytes(6).toString("hex");
  const png = assets.path(blog.id, DIRECTORY + "/" + name + ".png");
  const relPath = DIRECTORY + "/" + name + ".webp";

  try {
    log("taking", blog.id, template.id);

    // untrusted: the template is the blog's own code, so in production this
    // runs in the sandbox's browser jail (app/sandbox)
    try {
      await screenshot(template.previewURL, png, {
        width: WIDTH,
        height: HEIGHT,
        untrusted: true,
      });
    } catch (err) {
      // Keep the previous screenshot, and wait before trying again
      await client.hSet(
        key(blog.id),
        template.id,
        JSON.stringify({ ...previous, failedAt: Date.now() })
      );
      throw err;
    }

    const thumbnail = await sharp(png)
      .resize({ width: THUMBNAIL_WIDTH })
      .webp({ quality: 80 })
      .toBuffer();

    await assets.write(blog.id, relPath, thumbnail);

    await client.hSet(
      key(blog.id),
      template.id,
      JSON.stringify({
        path: relPath,
        templateCacheID: template.cacheID,
        blogCacheID: blog.cacheID,
        takenAt: Date.now(),
      })
    );

    if (previous && previous.path && previous.path !== relPath) {
      await assets.remove(blog.id, previous.path).catch(() => {});
    }

    log("took", blog.id, template.id, relPath);
  } finally {
    await fs.remove(png).catch(() => {});
    await client.del(lockKey(blog.id, template.id)).catch(() => {});
  }
}

// Removes screenshots of templates the blog no longer has
async function prune(blogID, entries, templateIDs) {
  const gone = Object.keys(entries).filter((id) => !templateIDs.has(id));
  if (!gone.length) return;

  await client.hDel(key(blogID), gone);
  for (const templateID of gone) {
    if (!entries[templateID].path) continue;
    await assets.remove(blogID, entries[templateID].path).catch(() => {});
  }
}

// Points each template that gets a screenshot at its screenshot URL (a
// redirect to the current file, see current()), queues the ones that need a
// new one, and prunes screenshots of deleted templates. `templates` is the
// blog's whole list, or just its live template. Templates with a screenshot
// on its way get screenshotState "pending", so the page can ask for it again.
async function decorate(blog, templates, { complete = false } = {}) {
  let entries;
  try {
    entries = await load(blog.id);
  } catch (err) {
    log("failed to load", blog.id, err.message);
    return;
  }

  for (const template of templates) {
    if (!wanted(blog, template)) continue;

    const entry = entries[template.id];
    const pending =
      isStale(entry, template, blog) && enqueue(blog, template, entry);

    if ((entry && entry.path) || pending)
      template.thumbnailURL = template.editURL + "/screenshot";
    template.screenshotState = pending ? "pending" : "";
  }

  if (complete) {
    prune(blog.id, entries, new Set(templates.map((t) => t.id))).catch((err) =>
      log("failed to prune", blog.id, err.message)
    );
  }
}

function wanted(blog, template) {
  return (
    !!template.previewURL &&
    (template.owner === blog.id || template.isMirror || !!template.checked)
  );
}

// The URL of a template's current screenshot, or null
async function current(blogID, templateID) {
  const value = await client.hGet(key(blogID), templateID);
  if (!value) return null;
  try {
    const { path } = JSON.parse(value);
    // A record of a failed first screenshot has no file
    return path ? assets.url(blogID, path) : null;
  } catch (e) {
    return null;
  }
}

module.exports = { decorate, current };
