// Rebuilds the entries whose stored HTML or metadata still links to files in
// the blog's folder with plain paths instead of the versioned CDN URLs that
// app/build/plugins/folderAssets (#1896) bakes at build time.
//
// Blot also rewrites those links into CDN URLs on every page render
// (app/blog/render/replaceFolderLinks), which is the work being moved to build
// time. An entry built before folderAssets shipped, or never rebuilt since,
// still depends on that request-time pass. This is the one-off backfill that
// closes that gap: it rebuilds just those entries, so folderAssets bakes the
// links, and once none are left the request-time pass has nothing to do for
// entries.
//
// WHEN TO RUN: after deploying the build code that bakes entry metadata
// (entries are rebuilt with the new build code). Run it on a host that can
// reach the blog folders and Redis, e.g. inside the app container. Run with
// --dry-run first to see how many entries it would touch.
//
// Detection is cheap and does no disk access. Each non-deleted entry's stored
// html, body, teaser and teaserBody (the fields build/index.js bakes) are
// scanned for an href, src, poster or srcset value the folderAssets plugin
// would treat as a folder link: a path starting with "/" (or an absolute URL
// on one of the blog's own hosts, which is stripped first) whose last segment
// has a file extension other than .html, and which does not already contain
// the %%BLOT_CDN%% token. poster and srcset values may also be relative to
// the entry, so those are matched when they look like a relative file too.
// Its metadata is checked too, for a value bakeMetadata would bake: the
// whole value a rooted or own-host link to such a file (image: /cover.jpg).
// Whether the file exists is not checked, so this over-selects (a link to a
// file that is gone stays plain after a rebuild and is matched again on the
// next run). Rebuilding is idempotent, so that costs time, not correctness.
//
// Safe to re-run, and to stop and resume: an entry that has been baked no
// longer matches, so a second run only touches what the first one did not
// reach. Entries are rebuilt one at a time, each under the blog's sync lock
// (re-read under the lock, since a sync may have changed it since the scan),
// yielding to the event loop between entries. If a blog's sync lock cannot
// be acquired (it is syncing) the blog is skipped with a log line rather than
// waited for; run the script again later to pick it up. A blog whose entries
// were rebuilt gets a new cacheID, as at the end of a sync, so rendered pages
// are not served from cache with the old links.
//
// A failing entry or blog is logged and counted; the exit code is non-zero
// if anything errored or was skipped, so an incomplete run isn't mistaken for
// a clean one.
//
// Usage:
//   node scripts/entry/rebuild-unbaked-folder-links.js [blog id, handle or domain] [--dry-run]
//
// With no blog argument every blog is processed. --dry-run only counts the
// entries per blog; it writes nothing and takes no lock.

const Blog = require("models/blog");
const Entries = require("models/entries");
const Entry = require("models/entry");
const establishSyncLock = require("sync/establishSyncLock");
const rebuildEntry = require("sync/update/rebuildEntry");
const blogHosts = require("blog/lib/blogHosts");
const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");
const { BLOG_STATIC_PATHS } = require("blog/lib/staticPaths");
const {
  htmlExtRegex,
  fileExtRegex,
  parseSrcset,
  hostPatterns: toHostPatterns,
  stripOwnHost,
  pathPartOf,
} = require("blog/render/replaceFolderLinks/shared");

// The stored fields app/build/index.js bakes (html via the plugin pipeline,
// the rest when front matter overrides them).
const FIELDS = ["html", "titleTag", "body", "teaser", "teaserBody"];

// Pre-filter: href/src/poster/srcset attributes, double, single or unquoted.
const ATTRIBUTE =
  /\b(href|src|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

// Mirrors isEligible in app/build/plugins/folderAssets/index.js (which does
// not export it) for a value which is already rooted, plus: not "//other.com",
// which that predicate lets through but which can never be a folder link.
function isFolderPath(value) {
  if (!value || typeof value !== "string") return false;
  if (value.indexOf("://") > -1) return false;
  if (value.startsWith("data:")) return false;
  if (value.indexOf(BLOT_CDN_TOKEN) > -1) return false;
  if (value.charAt(0) !== "/" || value.startsWith("//")) return false;

  const pathPart = pathPartOf(value);

  // Generated assets (/_image_cache/... for remote images Blot downloaded,
  // thumbnails, ...) aren't folder files and are never baked, so an entry
  // with them would match, and be rebuilt, on every run
  if (BLOG_STATIC_PATHS.some((dir) => pathPart === dir || pathPart.startsWith(dir + "/")))
    return false;

  if (htmlExtRegex.test(pathPart)) return false;
  if (!fileExtRegex.test(pathPart)) return false;

  return true;
}

// poster and srcset values are not normalized by app/build/dependencies, so
// the plugin resolves a relative one against the entry's path: treat any
// relative value that looks like a file as a candidate.
function isRelativeFile(value) {
  if (!value || typeof value !== "string") return false;
  if (/^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(value)) return false;
  if (value.indexOf(BLOT_CDN_TOKEN) > -1) return false;

  const pathPart = pathPartOf(value);

  return !!pathPart && !htmlExtRegex.test(pathPart) && fileExtRegex.test(pathPart);
}

function isCandidate(patterns, value, relativeToo) {
  if (isFolderPath(stripOwnHost(patterns, value))) return true;
  return relativeToo && isRelativeFile(value);
}

// Whether a stored HTML string has a link folderAssets would bake.
function hasUnbakedLink(html, patterns) {
  if (typeof html !== "string" || !html) return false;

  ATTRIBUTE.lastIndex = 0;

  let match;

  while ((match = ATTRIBUTE.exec(html))) {
    const attr = match[1].toLowerCase();
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];

    if (!value) continue;

    if (attr === "srcset") {
      // An unparseable srcset is left alone by the plugin, so ignore it.
      const candidates = parseSrcset(value);

      if (candidates && candidates.some((c) => isCandidate(patterns, c.url, true))) {
        return true;
      }
    } else if (isCandidate(patterns, value, attr === "poster")) {
      return true;
    }
  }

  return false;
}

function needsRebuild(entry, patterns) {
  if (!entry || entry.deleted) return false;

  return (
    FIELDS.some((field) => hasUnbakedLink(entry[field], patterns)) ||
    hasUnbakedMetadata(entry.metadata, patterns)
  );
}

// Whether entry metadata has a value folderAssets' bakeMetadata would bake
// (a whole rooted or own-host link to a file, e.g. image: /cover.jpg).
// Doesn't skip the keys bakeMetadata skips: over-selecting only costs a
// rebuild, and those keys (link, slug...) rarely hold a file path.
function hasUnbakedMetadata(metadata, patterns) {
  if (!metadata || typeof metadata !== "object") return false;

  return Object.values(metadata).some((value) => {
    if (typeof value !== "string") return false;

    value = value.trim();

    return !!value && !/\s/.test(value) && isCandidate(patterns, value, false);
  });
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const identifier = args.find((arg) => !arg.startsWith("--"));

const totals = {
  blogs: 0,
  blogsWithMatches: 0,
  matched: 0,
  rebuilt: 0,
  skippedBlogs: 0,
  notRebuilt: 0,
  errors: 0,
};

function scan(blog) {
  const patterns = toHostPatterns(
    blogHosts({ handle: blog.handle, domain: blog.domain })
  );
  const paths = [];

  return new Promise((resolve, reject) =>
    Entries.each(
      blog.id,
      function (entry, next) {
        if (needsRebuild(entry, patterns)) paths.push(entry.path);
        setImmediate(next);
      },
      (err) => (err ? reject(err) : resolve(paths))
    )
  );
}

async function rebuild(blog, paths) {
  let rebuilt = 0;

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    let lock;

    // Skip rather than wait if the blog is syncing.
    try {
      lock = await establishSyncLock(blog.id);
    } catch (err) {
      console.log(
        `${blog.handle} ${blog.id}: could not acquire sync lock, skipping ${
          paths.length - i
        } entries (re-run later): ${err.message}`
      );
      totals.skippedBlogs++;
      totals.notRebuilt += paths.length - i;
      break;
    }

    try {
      // Read again under the lock: a sync may have rebuilt or removed it.
      // Entry.get calls back (entry) on success and (undefined, err) on error
      const entry = await new Promise((resolve, reject) =>
        Entry.get(blog.id, path, (entry, err) => (err ? reject(err) : resolve(entry)))
      );

      if (entry && !entry.deleted) {
        await new Promise((resolve, reject) =>
          rebuildEntry(blog, entry, (err) => (err ? reject(err) : resolve()))
        );
        rebuilt++;
      }
    } catch (err) {
      totals.errors++;
      console.error(`${blog.handle} ${blog.id}: error rebuilding ${path}:`, err.message || err);
    } finally {
      try {
        await lock.done();
      } catch (err) {
        totals.errors++;
        console.error(`${blog.handle} ${blog.id}: error releasing sync lock:`, err.message || err);
      }
    }

    // Yield between entries so a large blog doesn't hog the event loop.
    await new Promise((resolve) => setImmediate(resolve));
  }

  if (rebuilt) {
    // Same as the end of a sync: render caches are keyed on cacheID.
    await new Promise((resolve) =>
      Blog.set(blog.id, { cacheID: Date.now() }, (err) => {
        if (err) {
          totals.errors++;
          console.error(`${blog.handle} ${blog.id}: error updating cacheID:`, err.message || err);
        }
        resolve();
      })
    );
  }

  return rebuilt;
}

async function processBlog(blog) {
  totals.blogs++;

  const paths = await scan(blog);

  if (!paths.length) return;

  totals.blogsWithMatches++;
  totals.matched += paths.length;

  if (dryRun) {
    console.log(`${blog.handle} ${blog.id}: ${paths.length} entries to rebuild`);
    return;
  }

  const rebuilt = await rebuild(blog, paths);

  totals.rebuilt += rebuilt;
  console.log(`${blog.handle} ${blog.id}: rebuilt ${rebuilt} of ${paths.length} matched entries`);
}

function blogIDs() {
  if (!identifier) {
    return new Promise((resolve, reject) =>
      Blog.getAllIDs((err, ids) => (err ? reject(err) : resolve(ids || [])))
    );
  }

  // An explicit identifier must resolve - never silently fall back to every
  // blog from a typo.
  // Looked up with Blog.get directly: scripts/get/blog also mints a login
  // token, which a read-only dry run mustn't do.
  const lookups = identifier.indexOf("blog_") === 0
    ? [{ id: identifier }]
    : [{ handle: identifier }, { domain: identifier }];

  return lookups.reduce(
    (found, query) =>
      found.then((ids) =>
        ids ||
        new Promise((resolve, reject) =>
          Blog.get(query, (err, blog) => (err ? reject(err) : resolve(blog ? [blog.id] : null)))
        )
      ),
    Promise.resolve(null)
  ).then((ids) => {
    if (!ids) throw new Error(`No blog found for "${identifier}"`);
    return ids;
  });
}

async function main() {
  console.log(
    dryRun ? "Dry run (nothing will be rebuilt)" : "Rebuilding entries with unbaked folder links"
  );

  const ids = (await blogIDs()).slice().sort();

  for (const blogID of ids) {
    const blog = await new Promise((resolve, reject) =>
      Blog.get({ id: blogID }, (err, blog) => (err ? reject(err) : resolve(blog)))
    );

    if (!blog || !blog.handle) continue;

    try {
      await processBlog(blog);
    } catch (err) {
      totals.errors++;
      console.error(`${blog.handle} ${blog.id}: failed:`, err.message || err);
    }
  }

  console.log("\n=== Rebuild unbaked folder links report ===");
  console.log(`Blogs scanned: ${totals.blogs}`);
  console.log(`Blogs with matching entries: ${totals.blogsWithMatches}`);
  console.log(`Entries matched: ${totals.matched}`);
  if (!dryRun) {
    console.log(`Entries rebuilt: ${totals.rebuilt}`);
    console.log(`Blogs skipped (sync lock busy): ${totals.skippedBlogs}`);
    console.log(`Entries not rebuilt (skipped blogs): ${totals.notRebuilt}`);
  }
  console.log(`Errors: ${totals.errors}`);

  return totals.errors === 0 && totals.skippedBlogs === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
