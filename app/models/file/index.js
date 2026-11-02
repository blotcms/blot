var client = require("models/client");
var ensure = require("helper/ensure");
var caseSensitivePath = require("helper/caseSensitivePath");
var key = require("./key");
var { pack, parse } = require("./record");

// The metadata index of a blog's folder: a record for every file and every
// directory (type, size, modified, SHA-1), so listing, walking, stat and case
// resolution never have to ask S3. It is derived from S3 and can be rebuilt
// from a full listing (rebuild below). storage/folder's S3 backend is its
// only writer. See README for the Redis layout.
//
// Writes read what they need first, then apply everything in one
// multi()/exec(). That is only safe because each blog has a single writer:
// every change to a blog's folder happens under its sync lock (sync/lock.js),
// so nothing can change the index between the read and the exec. No Lua and
// no WATCH, by house rule.

var normalize = key.normalize;

// The folder itself always exists
var ROOT = { type: "dir", size: 0, modified: 0, sha1: "" };

var PAGE = 1000;

function parentOf(path) {
  var i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function nameOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

// How names are compared ignoring case, as helper/caseSensitivePath.pick does
function fold(name) {
  return name.normalize().toLowerCase();
}

function child(dir, name) {
  return dir === "/" ? "/" + name : dir + "/" + name;
}

// Every ancestor of a path, nearest the root first, without the root
function ancestorsOf(path) {
  var parts = path.split("/").slice(1, -1);
  var result = [];

  for (var i = 1; i <= parts.length; i++) result.push("/" + parts.slice(0, i).join("/"));

  return result;
}

// The ZRANGEBYLEX bounds of everything below dir. "0" is the character after
// "/", so "(/a0" is just past the last path which starts "/a/".
function below(dir) {
  return dir === "/" ? ["-", "+"] : ["[" + dir + "/", "(" + dir + "0"];
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function check(blogID) {
  ensure(blogID, "string");
  if (!blogID) throw new Error("models/file: blogID must be a non-empty string");
}

// The names of a directory's lowercased-name field, with name added or taken
// away, as the value to store ("" when none are left)
function updateNames(joined, name, add) {
  var names = joined ? joined.split("/") : [];

  names = names.filter(function (existing) {
    return existing !== name;
  });

  if (add) names.push(name);

  return names.sort().join("/");
}

function setNames(multi, lowerKey, folded, joined) {
  if (joined) multi.hSet(lowerKey, folded, joined);
  else multi.hDel(lowerKey, folded);
}

// The record at path, or null
async function get(blogID, path) {
  check(blogID);
  path = normalize(path);

  if (path === "/") return Object.assign({}, ROOT);

  return parse(await client.hGet(key.dir(blogID, parentOf(path)), nameOf(path)));
}

// One page of a directory, in HSCAN order (not sorted):
// { entries: [{ name, type, size, modified, sha1 }], cursor }, where cursor
// is null after the last page. Resolves to null if dir is not a directory.
async function list(blogID, dir, options) {
  options = options || {};

  var record = await get(blogID, dir);

  if (!record || record.type !== "dir") return null;

  var reply = await client.hScan(key.dir(blogID, normalize(dir)), String(options.cursor || "0"), {
    COUNT: options.limit || PAGE,
  });
  var cursor = String(reply.cursor);

  return {
    entries: reply.entries.map(function (entry) {
      return Object.assign({ name: entry.field }, parse(entry.value));
    }),
    cursor: cursor === "0" ? null : cursor,
  };
}

// Every entry of a directory, sorted by name, or null if it is not one
async function listAll(blogID, dir) {
  var entries = [];
  var cursor = null;

  do {
    var page = await list(blogID, dir, { cursor: cursor });

    if (!page) return null;

    entries.push(...page.entries);
    cursor = page.cursor;
  } while (cursor);

  return entries.sort(byName);
}

// An async iterator of every path below dir (files and directories), in
// byte order of the whole path, a page at a time. Yields nothing for a
// missing directory.
async function* subtree(blogID, dir, options) {
  check(blogID);
  dir = normalize(dir);

  var count = (options && options.pageSize) || PAGE;
  var [min, max] = below(dir);

  while (true) {
    var page = await client.zRangeByLex(key.paths(blogID), min, max, {
      LIMIT: { offset: 0, count: count },
    });

    for (var path of page) yield path;

    if (page.length < count) return;

    min = "(" + page[page.length - 1];
  }
}

// The path which path names ignoring case, spelled as stored, or null. If
// several names in a directory differ only by case, the exact one wins,
// otherwise the first in sorted order: helper/caseSensitivePath.pick over
// the names, which the lowercased lookup keeps sorted.
async function resolveCaseInsensitive(blogID, path) {
  check(blogID);
  path = normalize(path);

  if (path === "/") return "/";

  var current = "/";

  for (var segment of path.split("/").slice(1)) {
    // Only a directory has a lookup, so a path below a file finds nothing
    var joined = await client.hGet(key.lower(blogID, current), fold(segment));
    var match = joined ? caseSensitivePath.pick(joined.split("/"), segment) : undefined;

    if (match === undefined) return null;

    current = child(current, match);
  }

  return current;
}

// { bytes, files } for the whole folder
async function totals(blogID) {
  check(blogID);

  var [bytes, files] = await client.hmGet(key.totals(blogID), ["bytes", "files"]);

  return { bytes: parseInt(bytes, 10) || 0, files: parseInt(files, 10) || 0 };
}

// Records several paths at once: items is [{ path, type, size, modified,
// sha1 }]. Every ancestor which has no record gets a directory record, since
// on S3 a directory can exist only because something is in it. A file
// replacing a file keeps the totals right. A file where a directory is, a
// directory where a file is, or anything below a file is refused (EISDIR,
// EEXIST, ENOTDIR), as it would be on disk.
async function setMany(blogID, items) {
  check(blogID);

  var now = Date.now();
  var wanted = new Map();

  for (var item of items) {
    var path = normalize(item.path);

    if (path === "/") throw new Error("models/file: the folder itself has no record");

    // Packed now so a bad record fails before anything is read
    pack(item);

    // A file and a directory at one path, as a listing could hold
    if (wanted.has(path) && wanted.get(path).type !== item.type) {
      throw failure(item.type === "dir" ? "EEXIST" : "EISDIR", "A file and a directory at: " + path);
    }

    wanted.set(path, item);
  }

  var ancestors = new Set();

  for (var path of wanted.keys()) {
    for (var ancestor of ancestorsOf(path)) {
      if (!wanted.has(ancestor)) ancestors.add(ancestor);
      else if (wanted.get(ancestor).type !== "dir") {
        throw failure("ENOTDIR", "Not a directory: " + ancestor);
      }
    }
  }

  var paths = [...wanted.keys(), ...ancestors];
  var existing = new Map();

  (
    await Promise.all(
      paths.map(function (path) {
        return client.hGet(key.dir(blogID, parentOf(path)), nameOf(path));
      })
    )
  ).forEach(function (packed, i) {
    existing.set(paths[i], parse(packed));
  });

  var writes = new Map();

  for (var ancestor of ancestors) {
    var found = existing.get(ancestor);

    if (found && found.type !== "dir") throw failure("ENOTDIR", "Not a directory: " + ancestor);
    if (!found) writes.set(ancestor, { type: "dir", size: 0, modified: now, sha1: "" });
  }

  for (var [path, item] of wanted) {
    var found = existing.get(path);

    if (found && found.type === "dir" && item.type !== "dir") {
      throw failure("EISDIR", "Is a directory: " + path);
    }

    if (found && found.type !== "dir" && item.type === "dir") {
      throw failure("EEXIST", "A file is in the way: " + path);
    }

    writes.set(path, item);
  }

  // The lowercased lookups of every name which is new to its directory
  var added = new Map();

  for (var path of writes.keys()) {
    if (existing.get(path)) continue;

    var lowerKey = key.lower(blogID, parentOf(path));
    var folded = fold(nameOf(path));
    var id = lowerKey + "\n" + folded;

    if (!added.has(id)) added.set(id, { lowerKey: lowerKey, folded: folded, names: [] });

    added.get(id).names.push(nameOf(path));
  }

  var lookups = [...added.values()];
  var current = await Promise.all(
    lookups.map(function (lookup) {
      return client.hGet(lookup.lowerKey, lookup.folded);
    })
  );

  var multi = client.multi();
  var bytes = 0;
  var files = 0;

  for (var [path, record] of writes) {
    var previous = existing.get(path);

    multi.hSet(key.dir(blogID, parentOf(path)), nameOf(path), pack(record));
    multi.zAdd(key.paths(blogID), { score: 0, value: path });

    if (record.type === "file") {
      bytes += (Number(record.size) || 0) - (previous ? previous.size : 0);
      if (!previous) files += 1;
    }
  }

  lookups.forEach(function (lookup, i) {
    var joined = current[i];

    for (var name of lookup.names) joined = updateNames(joined, name, true);

    setNames(multi, lookup.lowerKey, lookup.folded, joined);
  });

  if (bytes) multi.hIncrBy(key.totals(blogID), "bytes", bytes);
  if (files) multi.hIncrBy(key.totals(blogID), "files", files);

  await multi.exec();
}

// Records one path: record is { type, size, modified, sha1 }
function set(blogID, path, record) {
  return setMany(blogID, [Object.assign({}, record, { path: path })]);
}

// Forgets everything below a directory, deepest first, a page at a time, so
// each file's size is still in its parent's hash when it is counted. If this
// stops part way, what is left is still a consistent subtree, except that a
// parent's lowercased lookup may name a child already gone, until the parent
// itself goes; the reconcile repairs that.
async function removeBelow(blogID, dir) {
  var [min, max] = below(dir);

  while (true) {
    var page = await client.zRange(key.paths(blogID), max, min, {
      BY: "LEX",
      REV: true,
      LIMIT: { offset: 0, count: PAGE },
    });

    if (!page.length) return;

    var records = await Promise.all(
      page.map(function (path) {
        return client.hGet(key.dir(blogID, parentOf(path)), nameOf(path));
      })
    );

    var multi = client.multi();
    var bytes = 0;
    var files = 0;

    page.forEach(function (path, i) {
      var record = parse(records[i]);

      if (record && record.type === "file") {
        bytes += record.size;
        files += 1;
      } else {
        multi.del([key.dir(blogID, path), key.lower(blogID, path)]);
      }

      multi.hDel(key.dir(blogID, parentOf(path)), nameOf(path));
    });

    multi.zRem(key.paths(blogID), page);

    if (bytes) multi.hIncrBy(key.totals(blogID), "bytes", -bytes);
    if (files) multi.hIncrBy(key.totals(blogID), "files", -files);

    await multi.exec();
  }
}

// Forgets a file, or a directory and everything below it. Resolves to the
// record which was removed, or null if there was none.
async function remove(blogID, path) {
  check(blogID);
  path = normalize(path);

  if (path === "/") throw new Error("models/file: remove needs a path inside the folder");

  var record = await get(blogID, path);

  if (!record) return null;

  if (record.type === "dir") await removeBelow(blogID, path);

  var parent = parentOf(path);
  var name = nameOf(path);
  var lowerKey = key.lower(blogID, parent);
  var folded = fold(name);
  var joined = await client.hGet(lowerKey, folded);
  var multi = client.multi();

  multi.hDel(key.dir(blogID, parent), name);
  multi.zRem(key.paths(blogID), path);
  setNames(multi, lowerKey, folded, updateNames(joined, name, false));

  if (record.type === "dir") {
    multi.del([key.dir(blogID, path), key.lower(blogID, path)]);
  } else {
    if (record.size) multi.hIncrBy(key.totals(blogID), "bytes", -record.size);
    multi.hIncrBy(key.totals(blogID), "files", -1);
  }

  await multi.exec();

  return record;
}

// Forgets the whole folder, for blog deletion and before a rebuild
async function removeAll(blogID) {
  check(blogID);

  while (true) {
    var page = await client.zRange(key.paths(blogID), 0, PAGE - 1);

    if (!page.length) break;

    var multi = client.multi();
    var keys = [];

    // A file has no keys of its own, and deleting a missing key costs little
    // next to looking up which paths are directories
    for (var path of page) keys.push(key.dir(blogID, path), key.lower(blogID, path));

    multi.del(keys);
    multi.zRem(key.paths(blogID), page);

    await multi.exec();
  }

  await client.del([key.dir(blogID, "/"), key.lower(blogID, "/"), key.paths(blogID), key.totals(blogID)]);
}

// The errors setMany raises for a path which cannot exist beside what is
// already recorded: below a file, a file over a directory, a directory over
// a file
var CONFLICTS = ["ENOTDIR", "EISDIR", "EEXIST"];

// Replaces a blog's index with records from a full listing of its folder:
// records is an iterable or async iterable of { path, type, size, modified,
// sha1 }. Resolves to { files, dirs, bytes, skipped } as recorded.
//
// S3 can hold what a disk cannot: a file "a" and objects below "a/". Blot's
// own writes refuse to make that, but a listing may still contain it, so a
// record which conflicts with one recorded before it is skipped rather than
// failing the rebuild. skipped lists them as { path, type, code }: listing
// order puts "a" before "a/...", so the file is kept and what is below it
// skipped.
async function rebuild(blogID, records) {
  check(blogID);

  var counts = { files: 0, dirs: 0, bytes: 0, skipped: [] };
  var batch = [];

  async function flush() {
    try {
      await setMany(blogID, batch);
    } catch (err) {
      if (CONFLICTS.indexOf(err.code) === -1) throw err;

      // Nothing of the batch was written: setMany checks before its exec. One
      // at a time finds which records conflict.
      for (var record of batch) {
        try {
          await setMany(blogID, [record]);
        } catch (err) {
          if (CONFLICTS.indexOf(err.code) === -1) throw err;
          counts.skipped.push({ path: normalize(record.path), type: record.type, code: err.code });
        }
      }
    }

    batch = [];
  }

  await removeAll(blogID);

  for await (var record of records) {
    batch.push(record);

    if (batch.length >= 500) await flush();
  }

  if (batch.length) await flush();

  var sum = await totals(blogID);

  counts.files = sum.files;
  counts.bytes = sum.bytes;
  counts.dirs = (await client.zCard(key.paths(blogID))) - sum.files;

  return counts;
}

module.exports = {
  key,
  normalize,
  get,
  list,
  listAll,
  subtree,
  resolveCaseInsensitive,
  totals,
  set,
  setMany,
  remove,
  removeAll,
  rebuild,
};
