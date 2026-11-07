var config = require("config");
var fs = require("fs-extra");
// statfs is looked up on the module object when called, so specs can fake a full disk
var fsPromises = require("fs").promises;
var crypto = require("crypto");
var { pipeline } = require("stream/promises");
var { join, dirname, basename } = require("path");

// The content cache of the S3 backend (./s3.js): the bytes of blog files it
// has read, on the host's instance store, so a second read of the same file
// costs a disk read instead of a round trip to S3 (#2258, "Content cache").
//
// An entry is keyed by blog, path and content version: the file's SHA-1 from
// models/file, or its size and modified time where the index has no hash. A
// changed file has a new key, so a cached copy is never stale; correctness
// rests on the index, and the copy left under the old key just ages out.
// Nothing here is the only copy of anything and losing the directory costs
// only speed, so the cap can be as small as we like.
//
// On disk, under the cache's directory:
//
//   blogs/{blogID}/{id}/{name}  an entry: id is the SHA-1 of the path and
//                               version, name is the file's own name, kept so
//                               tools which look at the extension still work
//   tmp/{random}                a download in progress
//
// A download is written to tmp, checked against the size and SHA-1 the index
// gave, then renamed into place, so nobody ever sees a partial or wrong file.
// Two processes fetching the same entry each rename a complete copy over the
// other's, which is harmless.
//
// put() fills an entry the same way from bytes the caller already holds: the
// S3 backend's write-through, which hands over the bytes it has just uploaded
// (a Buffer, its spool file or the source of a writeFrom) under the version
// it has just recorded, so the read which usually follows a write is a hit.
// They go through the same tmp file, check and rename as a download, so a
// source which changed after its upload (rewritten by its owner while it was
// uploaded, say) is refused rather than cached under the wrong version. A put is not a
// hit or a miss, and its bytes are not fetchedBytes; it counts in filled.
//
// The LRU is bounded by bytes. Recency is the entry's modification time,
// which a hit sets, so the order survives a restart: the directory is
// scanned when the cache opens, and again every few minutes, which is also
// how a process learns about entries other processes (the other containers
// on the host) added or evicted. Each process enforces the cap from what it
// last saw, so with several processes the cap is a soft one, corrected at
// each scan.
//
// A path handed out may be evicted later, so callers use it at once, or hold
// it with use(), which is what storage/folder's withLocal does for a
// long-running tool (pandoc, sharp, a big upload). Nothing is evicted while
// this process has it pinned, nor, in any process, within GRACE_MS of its
// last use: that is what keeps a path ensureLocal just returned alive while a
// tool opens it.
//
// The pin reaches the other processes through that same recency. While use()
// holds an entry, a heartbeat sets its modification time again every third of
// the grace period, so to every other process it is always recent. Eviction
// checks the time on disk just before deleting (removeEntry), not the one it
// saw at its last scan, so no scan has to catch the touch for it to count. A
// holder which dies stops touching and the entry is evictable GRACE_MS later:
// there is no pin to clear and nothing for a crash to leave behind. A holder
// whose event loop is blocked for longer than the grace period loses the
// pin, which is the best effort the cache promises everywhere.
//
// A pinned entry may keep the cache over its budget: eviction skips it, and
// a fill is never refused for lack of room, since the reader asking for it is
// waiting on it. The overshoot lasts as long as the tools hold their paths,
// and the next scan after the release brings the cache back under its budget.

function noop() {}

// Entries used this recently are never evicted, by any process
var GRACE_MS = 60 * 1000;

// How often the directory is rescanned and the disk checked for room
var CHECK_INTERVAL_MS = 5 * 60 * 1000;

// A temporary file older than this was abandoned by a process which died; a
// younger one may be another process's download in progress
var ABANDONED_MS = 60 * 60 * 1000;

var ID = /^[0-9a-f]{40}$/;

// The bytes S3 sent are not the ones the index describes: the index is behind
// a write (it is updated after S3, see ./s3.js), or the object was replaced
// outside the app. Nothing is cached; callers read S3 directly or retry.
function changed(message) {
  var err = new Error(message);
  err.code = "ECHANGED";
  return err;
}

function idOf(path, version) {
  return crypto
    .createHash("sha1")
    .update(path + "\0" + version)
    .digest("hex");
}

// options:
//   dir             the cache's directory
//   maxBytes        the byte budget for every entry together
//   graceMs         see GRACE_MS
//   checkIntervalMs see CHECK_INTERVAL_MS; 0 for no periodic check
//   minFreePercent  evict when the disk has less free than this
function createCache(options) {
  var dir = options.dir;
  var maxBytes = options.maxBytes;
  var graceMs = options.graceMs === undefined ? GRACE_MS : options.graceMs;
  var checkIntervalMs =
    options.checkIntervalMs === undefined
      ? CHECK_INTERVAL_MS
      : options.checkIntervalMs;
  var minFreePercent = options.minFreePercent || 0;

  if (!dir || !(maxBytes >= 0))
    throw new Error("storage/folder cache needs a dir and a maxBytes");

  var blogsDir = join(dir, "blogs");
  var tmpDir = join(dir, "tmp");

  // "{blogID}/{id}" -> { file, size, used, pins }. Map order is recency:
  // the first is the least recently used.
  var entries = new Map();
  var entryBytes = 0;
  var writingBytes = 0;
  var downloads = new Map();
  // name -> the promise of an eviction deleting it
  var removing = new Map();
  var counters = {
    hits: 0,
    misses: 0,
    evictions: 0,
    fetchedBytes: 0,
    changed: 0,
    filled: 0,
  };
  var timer = null;
  var checking = null;
  // While a scan runs: the names evicted since it started, which its listing
  // may still show
  var evictedDuringScan = null;
  // Heartbeats of the entries use() is holding
  var heartbeats = new Set();

  function add(name, entry) {
    forget(name);
    entries.set(name, entry);
    entryBytes += entry.size;
  }

  function forget(name) {
    var entry = entries.get(name);
    if (!entry) return;
    entries.delete(name);
    entryBytes -= entry.size;
  }

  function locate(spec) {
    var id = idOf(spec.path, spec.version);

    return {
      name: spec.blogID + "/" + id,
      file: join(blogsDir, spec.blogID, id, basename(spec.path)),
    };
  }

  // Marks an entry used now, on disk too so other processes and the next
  // scan see it. Fails with ENOENT if another process evicted it.
  async function touch(name, entry) {
    var now = new Date();

    await fs.utimes(entry.file, now, now);

    entry.used = now.getTime();
    if (entries.get(name) === entry) {
      entries.delete(name);
      entries.set(name, entry);
    }
  }

  // The entry for spec if it is on disk, here or put there by another
  // process, marked used and, with pin, pinned
  async function lookup(spec, pin) {
    var { name, file } = locate(spec);

    // Being evicted: it will be gone in a moment
    if (removing.has(name)) await removing.get(name);

    var entry = entries.get(name);

    if (!entry) {
      try {
        var stat = await fs.stat(file);
        if (stat.size !== spec.size) return null;
        entry = entries.get(name) || {
          file: file,
          size: stat.size,
          used: stat.mtimeMs,
          pins: 0,
        };
        if (!entries.has(name)) add(name, entry);
      } catch (err) {
        if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
        throw err;
      }
    }

    if (pin) entry.pins++;

    try {
      await touch(name, entry);
    } catch (err) {
      if (pin) entry.pins--;
      if (err.code !== "ENOENT") throw err;
      if (entries.get(name) === entry) forget(name);
      return null;
    }

    return entry;
  }

  // Disk times can be a fraction of a millisecond ahead of Date.now()
  function recent(used, now) {
    return graceMs > 0 && now - used < graceMs;
  }

  function evictable(entry, now) {
    return !entry.pins && !recent(entry.used, now);
  }

  // Evicts least recently used entries until `needed` more bytes fit in the
  // budget, or until `bytes` have gone when that is given. Chooses in one go,
  // so two callers never pick the same entries, then checks each on disk: an
  // entry another process used within the grace period is kept.
  async function evict(needed, bytes) {
    var now = Date.now();
    var short =
      bytes === undefined
        ? entryBytes + writingBytes + needed - maxBytes
        : bytes;
    var doomed = [];

    for (var [name, entry] of entries) {
      if (short <= 0) break;
      if (!evictable(entry, now)) continue;
      doomed.push([name, entry]);
      short -= entry.size;
    }

    doomed.forEach(function ([name]) {
      forget(name);
    });

    await Promise.all(
      doomed.map(function ([name, entry]) {
        var removal = removeEntry(name, entry, now).finally(function () {
          removing.delete(name);
        });

        removing.set(name, removal);
        return removal;
      })
    );
  }

  async function removeEntry(name, entry, now) {
    try {
      var stat = await fs.stat(entry.file);

      if (recent(stat.mtimeMs, now)) {
        entry.used = stat.mtimeMs;
        if (!entries.has(name)) add(name, entry);
        return;
      }

      await fs.remove(dirname(entry.file));
      counters.evictions++;
      if (evictedDuringScan) evictedDuringScan.add(name);
    } catch (err) {
      // Gone already: another process evicted it
      if (err.code !== "ENOENT")
        console.error(
          "storage/folder cache: could not evict " + entry.file,
          err
        );
    }
  }

  // fetched: open() reads S3, so its bytes count as fetched and a mismatch as
  // S3 holding a version the index does not have
  async function download(spec, open, file, fetched) {
    var temporary = join(tmpDir, crypto.randomBytes(12).toString("hex"));
    var hash = crypto.createHash("sha1");
    var bytes = 0;

    writingBytes += spec.size;

    try {
      await evict(0);
      await fs.ensureDir(tmpDir);

      var body = await open();

      await pipeline(
        body,
        async function* (source) {
          for await (var chunk of source) {
            hash.update(chunk);
            bytes += chunk.length;
            yield chunk;
          }
        },
        fs.createWriteStream(temporary)
      );

      if (fetched) counters.fetchedBytes += bytes;

      if (
        bytes !== spec.size ||
        (spec.sha1 && hash.digest("hex") !== spec.sha1)
      ) {
        if (fetched) counters.changed++;
        throw changed(
          "storage/folder cache: " +
            spec.path +
            (fetched ? " in S3" : "") +
            " is not the version the index has"
        );
      }

      // An empty entry directory may be removed by another process's scan
      // between the two calls below, so the rename is tried twice
      for (var attempt = 0; ; attempt++) {
        try {
          await fs.ensureDir(dirname(file));
          await fs.rename(temporary, file);
          break;
        } catch (err) {
          if (err.code !== "ENOENT" || attempt) throw err;
        }
      }
    } catch (err) {
      await fs.remove(temporary).catch(noop);
      throw err;
    } finally {
      writingBytes -= spec.size;
    }
  }

  // The local path of the file spec describes, downloading it with open()
  // (which resolves to a readable stream of its bytes) on a miss. Concurrent
  // calls for one entry share one download.
  //   spec  { blogID, path, version, size, sha1 }: sha1 may be empty
  //   outcome  optional, called with "hit" or "miss" as this call is counted,
  //            so a caller learns what happened to its own read (the
  //            counters are shared by every concurrent one)
  async function get(spec, open, pin, outcome) {
    var entry = await lookup(spec, pin);

    if (entry) {
      counters.hits++;
      if (outcome) outcome("hit");
      return entry.file;
    }

    counters.misses++;
    if (outcome) outcome("miss");

    entry = await fill(spec, open, true);

    if (pin) entry.pins++;

    return entry.file;
  }

  // Downloads the entry spec describes and adds it. Concurrent fills of one
  // entry share one download. A read (fetched) which joined a put's fill
  // does not inherit that fill's failure, since a put's source is the
  // writer's own copy and is optional: it fills the entry itself instead.
  async function fill(spec, open, fetched) {
    var { name, file } = locate(spec);

    if (!downloads.has(name)) {
      var fetching = download(spec, open, file, fetched).finally(function () {
        if (downloads.get(name) === current) downloads.delete(name);
      });
      var current = { promise: fetching, fetched: fetched };

      downloads.set(name, current);
    }

    var joined = downloads.get(name);

    try {
      await joined.promise;
    } catch (err) {
      if (!fetched || joined.fetched) throw err;

      return fill(spec, open, fetched);
    }

    var now = Date.now();
    var entry = entries.get(name);

    if (entry) entry.used = now;
    else
      add(name, (entry = { file: file, size: spec.size, used: now, pins: 0 }));

    return entry;
  }

  // Stores the bytes open() resolves to (a readable stream) as the entry spec
  // describes, unless it is there already, which it then marks used. Returns
  // nothing and pins nothing: the caller has the bytes, and wants the next
  // reader to find them. Rejects with ECHANGED if they are not the version
  // spec describes.
  async function put(spec, open) {
    if (await lookup(spec, false)) return;

    await fill(spec, open, false);
    counters.filled++;
  }

  // Keeps an entry recent on disk, for the other processes, while it is held
  function hold(name, file) {
    if (!(graceMs > 0)) return null;

    var beat = setInterval(
      function () {
        var entry = entries.get(name);
        var now = new Date();

        if (entry && entry.file === file) entry.used = now.getTime();

        // Gone (removeBlog, or evicted by a process which saw no recent use):
        // there is nothing to keep
        fs.utimes(file, now, now).catch(noop);
      },
      Math.max(1, Math.floor(graceMs / 3))
    );

    beat.unref();
    heartbeats.add(beat);

    return beat;
  }

  function release(beat) {
    if (!beat) return;
    clearInterval(beat);
    heartbeats.delete(beat);
  }

  // Calls fn with the local path of the file spec describes, which is not
  // evicted, here or by any other process using the directory, until the
  // promise fn returns has settled
  async function use(spec, open, fn, outcome) {
    var file = await get(spec, open, true, outcome);
    var { name } = locate(spec);
    var heartbeat = hold(name, file);

    try {
      return await fn(file);
    } finally {
      release(heartbeat);
      var entry = entries.get(name);
      if (entry && entry.file === file && entry.pins > 0) entry.pins--;
    }
  }

  // Forgets every entry of a blog and deletes them
  async function removeBlog(blogID) {
    var prefix = blogID + "/";

    for (var name of Array.from(entries.keys())) {
      if (name.indexOf(prefix) === 0) forget(name);
    }

    await fs.remove(join(blogsDir, blogID));
  }

  // Rebuilds the recency list from the directory, keeping what this process
  // learned since the scan started, and clears what dead processes left
  async function scan() {
    var started = Date.now();
    var found = [];

    evictedDuringScan = new Set();

    await fs.ensureDir(blogsDir);

    for (var temporary of await readdir(tmpDir)) {
      var stat = await fs.stat(join(tmpDir, temporary)).catch(noop);
      if (stat && started - stat.mtimeMs > ABANDONED_MS)
        await fs.remove(join(tmpDir, temporary)).catch(noop);
    }

    for (var blogID of await readdir(blogsDir)) {
      for (var id of await readdir(join(blogsDir, blogID))) {
        var entryDir = join(blogsDir, blogID, id);
        var names = ID.test(id) ? await readdir(entryDir) : [];
        var file = names.length === 1 ? join(entryDir, names[0]) : null;
        var info = file && (await fs.stat(file).catch(noop));

        if (info && info.isFile()) {
          found.push({
            name: blogID + "/" + id,
            entry: { file: file, size: info.size, used: info.mtimeMs, pins: 0 },
          });
          continue;
        }

        // Not an entry: something half made or foreign. Left alone while it
        // may be another process's rename in progress.
        var dirStat = await fs.stat(entryDir).catch(noop);
        if (dirStat && started - dirStat.mtimeMs > ABANDONED_MS)
          await fs.remove(entryDir).catch(noop);
      }
    }

    var previous = entries;
    var evicted = evictedDuringScan;

    evictedDuringScan = null;

    // The listing may predate an eviction. Counting the entry again would
    // make the next eviction pass remove a live one to make up for it.
    found = found.filter(function (item) {
      return !evicted.has(item.name) || previous.has(item.name);
    });

    found.forEach(function (item) {
      var known = previous.get(item.name);
      if (known && known.file === item.entry.file) {
        known.used = Math.max(known.used, item.entry.used);
        known.size = item.entry.size;
        item.entry = known;
      }
    });

    // Entries added here while the scan ran may have been missed by it
    var seen = new Set(found.map((item) => item.name));
    for (var [name, entry] of previous) {
      if (!seen.has(name) && (entry.pins || entry.used >= started))
        found.push({ name: name, entry: entry });
    }

    found.sort(function (a, b) {
      return a.entry.used - b.entry.used;
    });

    entries = new Map();
    entryBytes = 0;
    found.forEach(function (item) {
      add(item.name, item.entry);
    });
  }

  async function readdir(directory) {
    try {
      return await fs.readdir(directory);
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
      throw err;
    }
  }

  // Bytes to free so the disk keeps minFreePercent free, from statfs
  async function diskShortfall() {
    if (!minFreePercent) return 0;

    var disk = await fsPromises.statfs(dir);
    var wanted = (disk.blocks * minFreePercent) / 100;

    return disk.bavail < wanted
      ? Math.ceil((wanted - disk.bavail) * disk.bsize)
      : 0;
  }

  // Rescans the directory, brings the cache back under its budget, and
  // evicts more if the disk itself is short of room (other users of the
  // instance store, such as the git cache and tmp, share it). One at a time.
  function check() {
    if (!checking) {
      checking = (async function () {
        await scan();
        await evict(0);

        var shortfall = await diskShortfall();

        if (shortfall > 0) await evict(0, shortfall);
      })().finally(function () {
        checking = null;
      });
    }

    return checking;
  }

  var ready = check().catch(function (err) {
    console.error("storage/folder cache: could not scan " + dir, err);
  });

  if (checkIntervalMs > 0) {
    timer = setInterval(function () {
      check().catch(function (err) {
        console.error("storage/folder cache: check failed", err);
      });
    }, checkIntervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    heartbeats.forEach(clearInterval);
    heartbeats.clear();
  }

  function stats() {
    return Object.assign(
      { maxBytes: maxBytes, entries: entries.size, bytes: entryBytes },
      counters
    );
  }

  return {
    dir: dir,
    ready: function () {
      return ready;
    },
    get: function (spec, open, outcome) {
      return get(spec, open, false, outcome);
    },
    use: use,
    put: put,
    removeBlog: removeBlog,
    check: check,
    stats: stats,
    stop: stop,
  };
}

var shared = null;

// The host's cache, configured by config.folder_cache, made on first use
function cache() {
  if (!shared) {
    shared = createCache({
      dir: config.folder_cache.directory,
      maxBytes: config.folder_cache.max_bytes,
      minFreePercent: config.folder_cache.min_free_percent,
    });
  }

  return shared;
}

module.exports = cache;
module.exports.createCache = createCache;
