const fs = require("fs-extra");
const path = require("path");
const alphanum = require("helper/alphanum");
const localPath = require("helper/localPath");
const Stat = require("./stat");
const client = require("models/client");
const pathNormalize = require("helper/pathNormalizer");
const IgnoredFiles = require("models/ignoredFiles");
const postSourceSize = require("build/converters/post-source-size");

// Folders synced from Dropbox, Google Drive, git etc. can contain tens of
// thousands of files. Statting every entry, checking Redis for a matching
// post and rendering one <tr> per file used to happen in a single pass which
// could exhaust file descriptors / Redis connections and crash the server
// (see TODO: "Fix bug with folder viewer which crashes server for large
// number of entries"). The dashboard now asks for one small page at a time
// and scrolls the rest in.
const DEFAULT_PAGE_SIZE = 100;

// Sorting by date or size needs stat data for every entry, not just the page
// being shown. We sweep the whole folder with bounded concurrency and cache
// the result so the follow-up infinite-scroll page fetches don't re-stat.
// The cache is bounded so a few huge folders can't pin unbounded memory.
const STAT_SWEEP_CONCURRENCY = 32;
const STAT_CACHE_LIMIT = 8;
const statCache = new Map(); // "blogID_cacheID_dir" -> Promise<stat[]>

const STAT_SORT_KEY = { modified: "unix", size: "bytes" };

function resolvePageSize(pageSize) {
  const parsed = parseInt(pageSize, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  // Never allow a caller to request a larger page than the default – the
  // whole point is to bound the amount of work per request.
  return Math.min(parsed, DEFAULT_PAGE_SIZE);
}

function resolveSort(sort) {
  return sort === "modified" || sort === "size" ? sort : "name";
}

function resolveOrder(order) {
  return order === "desc" ? "desc" : "asc";
}

// The server is now the sole authority on row order (directory.html no
// longer re-sorts on load), so order names here the way a file browser
// does: natural, case-insensitive alphanumeric — "file2" before "file10",
// "1 copy 2.txt" before "1 copy 10.txt". The same comparator decides page
// boundaries and the tie-break for date / size sorts, so a name never lands
// on a different page than the one that then renders it.
function byDisplayName(a, b) {
  return alphanum.compare(String(a).trim(), String(b).trim(), {
    insensitive: true,
  });
}

// Small promise pool: run fn over items, at most `limit` in flight.
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

async function statEntry(blog, dir, local, name) {
  const fullPath = path.join(local, name);

  let stat;
  try {
    stat = await Stat(fullPath, blog.timeZone);
  } catch (err) {
    // The file was removed between readdir and stat (common while a large
    // folder is still syncing). Skip it rather than failing the listing.
    if (err && err.code === "ENOENT") return null;
    throw err;
  }

  stat.path = path.join(dir, name);
  // we don't want to turn '/' into '%2F' so we split on '/' and encode each part separately
  stat.url = stat.path.split("/").map(encodeURIComponent).join("/");
  stat.fullPath = fullPath;
  stat.name = name;

  return stat;
}

// Stat every entry once, cached per folder. Used for date / size sorts,
// which can't be ordered without stat data for the whole folder.
function readStatSweep(blog, dir, local, names) {
  const key = blog.id + "_" + blog.cacheID + "_" + dir;
  const cached = statCache.get(key);

  if (cached) {
    // refresh LRU position
    statCache.delete(key);
    statCache.set(key, cached);
    return cached;
  }

  const sweep = mapWithLimit(names, STAT_SWEEP_CONCURRENCY, (name) =>
    statEntry(blog, dir, local, name)
  ).then((stats) => stats.filter((stat) => stat !== null));

  // Don't leave a rejected promise cached.
  sweep.catch(() => {
    if (statCache.get(key) === sweep) statCache.delete(key);
  });

  statCache.set(key, sweep);
  while (statCache.size > STAT_CACHE_LIMIT) {
    statCache.delete(statCache.keys().next().value);
  }

  return sweep;
}

function invalidateStatCache(blog) {
  const prefix = `${blog.id}_${blog.cacheID}_`;
  for (const key of statCache.keys()) {
    if (key.startsWith(prefix)) statCache.delete(key);
  }
}

// Attach the post / ignored-file flags the template needs. Only the page
// being rendered is looked up in Redis, so this stays bounded.
async function decorate(blog, dir, pageStats) {
  const pageNames = pageStats.map((stat) => stat.name);

  const [entries, ignoredFiles] = await Promise.all([
    new Promise((resolve) => {
      const keys = pageNames.map(
        (item) => `blog:${blog.id}:entry:${pathNormalize(path.join(dir, item))}`
      );
      Promise.all(keys.map((key) => client.exists(key)))
        .then((res) => {
          if (!res || !res.length) return resolve([]);
          resolve(
            pageNames.filter((_, index) => {
              const exists = res[index];
              return exists === 1 || exists === "1" || exists === true;
            })
          );
        })
        .catch(() => resolve([]));
    }),
    new Promise((resolve, reject) => {
      const childPaths = pageNames.map((item) => path.join(dir, item));
      IgnoredFiles.getStatuses(blog.id, childPaths, function (err, ignored) {
        if (err) return reject(err);
        resolve(ignored);
      });
    }),
  ]);

  return pageStats.map((stat) => {
    stat.entry = entries.includes(stat.name);
    stat.tooLarge = ignoredFiles[pathNormalize(stat.path)] === "TOO_LARGE";
    if (stat.tooLarge) {
      // A previously published source that grew too large leaves a deleted
      // entry tombstone behind; don't show it as a live post.
      stat.entry = false;
      stat.postSizeLimit = postSourceSize.limitForPath(stat.path).label;
    }
    return stat;
  });
}

function clampPage(requestedPage, total, pageSize) {
  const estimatedPages = Math.max(1, Math.ceil(total / pageSize));
  const parsed = parseInt(requestedPage, 10);
  return Math.min(Math.max(Number.isFinite(parsed) ? parsed : 1, 1), estimatedPages);
}

async function getContents(blog, dir, options = {}) {
  const pageSize = resolvePageSize(options.pageSize);
  const sort = resolveSort(options.sort);
  const order = resolveOrder(options.order);
  const descending = order === "desc";

  const local = localPath(blog.id, dir);
  const names = (await fs.readdir(local))
    .filter((item) => !item.startsWith(".") && !item.endsWith(".preview.html"))
    .sort(byDisplayName);

  let page;
  let startIndex;
  let pageStats;
  let total;
  let hasNext;

  if (sort === "name") {
    const ordered = descending ? names.slice().reverse() : names;
    total = ordered.length;
    page = clampPage(options.page, total, pageSize);
    startIndex = (page - 1) * pageSize;

    // Walk forward from startIndex collecting up to pageSize entries that
    // still exist. Files vanish between readdir and stat while a folder is
    // syncing; skipping them without pulling the next name forward would
    // leave the page short and the running count adrift.
    const collected = [];
    let cursor = startIndex;

    while (collected.length < pageSize && cursor < ordered.length) {
      const batch = ordered.slice(cursor, cursor + (pageSize - collected.length));
      cursor += batch.length;

      const batchStats = await mapWithLimit(
        batch,
        STAT_SWEEP_CONCURRENCY,
        (name) => statEntry(blog, dir, local, name)
      );

      for (const stat of batchStats) if (stat !== null) collected.push(stat);
    }

    pageStats = collected;
    hasNext = cursor < ordered.length;
  } else {
    // Date / size sort: needs a stat for every entry, so sweep (and cache)
    // the whole folder, then order and slice.
    const allStats = (await readStatSweep(blog, dir, local, names)).slice();
    const key = STAT_SORT_KEY[sort];

    allStats.sort((a, b) => {
      const av = a[key] || 0;
      const bv = b[key] || 0;
      if (av === bv) return byDisplayName(a.name, b.name);
      return descending ? bv - av : av - bv;
    });

    total = allStats.length;
    page = clampPage(options.page, total, pageSize);
    startIndex = (page - 1) * pageSize;
    pageStats = allStats.slice(startIndex, startIndex + pageSize);
    hasNext = startIndex + pageStats.length < total;
  }

  const result = await decorate(blog, dir, pageStats);

  const estimatedPages = Math.max(1, Math.ceil(total / pageSize));

  const pagination = {
    page,
    pageSize,
    sort,
    order,
    // On the last page report the real number; otherwise the upper bound.
    totalPages: hasNext ? Math.max(estimatedPages, page + 1) : page,
    total,
    // 1-indexed range of items shown, for "1–100 of 12,384".
    rangeStart: result.length === 0 ? 0 : startIndex + 1,
    rangeEnd: result.length === 0 ? 0 : startIndex + result.length,
    hasPrevious: page > 1,
    hasNext,
    previousPage: page - 1,
    nextPage: page + 1,
    // Only show controls when the listing actually spans more than one page.
    multiplePages: page > 1 || hasNext,
  };

  return { contents: result, pagination };
}

getContents.DEFAULT_PAGE_SIZE = DEFAULT_PAGE_SIZE;
getContents.invalidateStatCache = invalidateStatCache;

module.exports = getContents;
