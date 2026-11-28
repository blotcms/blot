var client = require("models/client");
var ensure = require("helper/ensure");
var caseSensitivePath = require("helper/caseSensitivePath");
var key = require("./key");
var { pack, parse } = require("./record");
var flags = require("./flags");
var SORTS = require("./sorts");

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

  for (var i = 1; i <= parts.length; i++)
    result.push("/" + parts.slice(0, i).join("/"));

  return result;
}

// Listings are in natural name order, the order of the "all" sorted set
// (key.sortMember). A directory without one is sorted the same way here,
// comparing members as bytes as Redis does.
var ALL = "all";

function bySorted(entries) {
  return entries
    .map(function (entry) {
      return { entry: entry, member: key.sortMember(entry.name) };
    })
    .sort(function (a, b) {
      return key.compareSorted(a.member, b.member);
    })
    .map(function (item) {
      return item.entry;
    });
}

// Whether name comes after the name after in listing order
function isAfter(name, after) {
  return key.compareSorted(key.sortMember(name), key.sortMember(after)) > 0;
}

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function check(blogID) {
  ensure(blogID, "string");
  if (!blogID)
    throw new Error("models/file: blogID must be a non-empty string");
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

// The keys of a directory's sorted sets, one per order in sorts.js
function sortKeys(blogID, dir) {
  return SORTS.map(function (order) {
    return key.sort(blogID, order.name, dir);
  });
}

// Queues adding children ({ name, type }) to each of a directory's sorted
// sets that holds them, a page per ZADD
function addSorted(multi, blogID, dir, children) {
  for (const order of SORTS) {
    var members = children.filter(order.holds).map(function (entry) {
      return { score: 0, value: order.member(entry.name) };
    });

    for (var i = 0; i < members.length; i += PAGE)
      multi.zAdd(key.sort(blogID, order.name, dir), members.slice(i, i + PAGE));
  }
}

// Queues removing a child from each of its directory's sorted sets. ZREM
// never creates a key, so a directory without them stays without them.
function removeSorted(multi, blogID, dir, name) {
  for (const order of SORTS)
    multi.zRem(key.sort(blogID, order.name, dir), order.member(name));
}

// The record at path, or null
async function get(blogID, path) {
  check(blogID);
  path = normalize(path);

  if (path === "/") return Object.assign({}, ROOT);

  return parse(
    await client.hGet(key.dir(blogID, parentOf(path)), nameOf(path))
  );
}

// Every entry of a directory's hash, a HSCAN page at a time, unsorted
async function scan(blogID, dir) {
  var entries = [];
  var cursor = "0";

  do {
    var reply = await client.hScan(key.dir(blogID, dir), cursor, {
      COUNT: PAGE,
    });

    for (var entry of reply.entries)
      entries.push(Object.assign({ name: entry.field }, parse(entry.value)));

    cursor = String(reply.cursor);
  } while (cursor !== "0");

  return entries;
}

// One page of a directory, in natural name order (key.sortMember):
// { entries: [{ name, type, size, modified, sha1 }], next }, where next is
// the name to pass as after for the page which follows, or null after the
// last page. after need not still be in the directory. Resolves to null if
// dir is not a directory.
//
// A page is one ZRANGEBYLEX of the directory's "all" sorted set and one
// HMGET of the page's names, however large the directory. after is turned
// back into its member, so it need not still be there. A directory without
// the set (see README) is read whole and sorted the same way instead.
async function list(blogID, dir, options) {
  check(blogID);
  options = options || {};
  dir = normalize(dir);

  var limit = options.limit === undefined ? PAGE : options.limit;
  var after =
    options.after === undefined || options.after === null
      ? null
      : String(options.after);

  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("models/file: limit must be a positive integer");

  var sortKey = key.sort(blogID, ALL, dir);

  // Sent together, so one round trip
  var [record, sorted, members] = await Promise.all([
    get(blogID, dir),
    client.exists(sortKey),
    client.zRangeByLex(
      sortKey,
      after === null ? "-" : "(" + key.sortMember(after),
      "+",
      {
        LIMIT: { offset: 0, count: limit + 1 },
      }
    ),
  ]);

  if (!record || record.type !== "dir") return null;

  if (!sorted) {
    var all = bySorted(await scan(blogID, dir)).filter(function (entry) {
      return after === null || isAfter(entry.name, after);
    });

    return {
      entries: all.slice(0, limit),
      next: all.length > limit ? all[limit - 1].name : null,
    };
  }

  var names = members.slice(0, limit).map(key.nameOfSorted);
  var packed = names.length
    ? await client.hmGet(key.dir(blogID, dir), names)
    : [];
  var entries = [];

  // A name with no record would mean the set and the hash disagree, which
  // the writes below never leave behind; it is skipped rather than invented
  names.forEach(function (name, i) {
    if (packed[i] !== null && packed[i] !== undefined)
      entries.push(Object.assign({ name: name }, parse(packed[i])));
  });

  return {
    entries: entries,
    next: members.length > limit ? names[names.length - 1] : null,
  };
}

// An async iterator of the pages of a directory, in order: arrays of
// entries, as list gives them. Rejects with ENOENT if dir is not a
// directory when it starts; a directory removed part way just ends. A
// directory without the sorted set is read whole once, not once a page.
async function* pages(blogID, dir, options) {
  check(blogID);
  dir = normalize(dir);

  var limit = (options && options.limit) || PAGE;
  var [record, sorted] = await Promise.all([
    get(blogID, dir),
    client.exists(key.sort(blogID, ALL, dir)),
  ]);

  if (!record || record.type !== "dir")
    throw failure("ENOENT", "Not a directory: " + dir);

  if (!sorted) {
    var all = bySorted(await scan(blogID, dir));

    for (var i = 0; i < all.length; i += limit) yield all.slice(i, i + limit);

    return;
  }

  var after = null;

  do {
    var page = await list(blogID, dir, { after: after, limit: limit });

    if (!page) return;

    yield page.entries;
    after = page.next;
  } while (after !== null);
}

// Every entry of a directory, in listing order, or null if it is not one. The
// whole directory ends up in memory: use list or pages for a large one.
async function listAll(blogID, dir) {
  var entries = [];

  try {
    for await (var page of pages(blogID, dir)) entries.push(...page);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  return entries;
}

// A page of a directory's visible children (those not hidden everywhere:
// dotfiles and .preview.html, key.hiddenEverywhere) by position, for pages
// a person picks by number: { entries, total }, entries in listing order,
// or reversed with { order: "desc" }, and total the number of visible
// children. Null if dir is not a directory.
//
// The visible children are the first ranks of the "all" set, so total is
// one ZLEXCOUNT and the page one ZRANGE by rank, O(log N + page) however
// deep the page, then one HMGET. A descending page reads the same ranks
// counted from the end of the visible ones, not from the end of the set,
// which holds the hidden children.
async function range(blogID, dir, options) {
  check(blogID);
  options = options || {};
  dir = normalize(dir);

  var offset = options.offset === undefined ? 0 : options.offset;
  var limit = options.limit === undefined ? PAGE : options.limit;
  var descending = options.order === "desc";

  if (!Number.isInteger(offset) || offset < 0)
    throw new Error("models/file: offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("models/file: limit must be a positive integer");

  var sortKey = key.sort(blogID, ALL, dir);

  var [record, sorted, total] = await Promise.all([
    get(blogID, dir),
    client.exists(sortKey),
    client.zLexCount(sortKey, "[\u0001", "(\u0002"),
  ]);

  if (!record || record.type !== "dir") return null;

  if (!sorted) {
    var visible = bySorted(await scan(blogID, dir)).filter(function (entry) {
      return !key.hiddenEverywhere(entry.name);
    });

    if (descending) visible.reverse();

    return {
      entries: visible.slice(offset, offset + limit),
      total: visible.length,
    };
  }

  var start = descending ? total - offset - limit : offset;
  var stop = descending
    ? total - offset - 1
    : Math.min(offset + limit, total) - 1;

  start = Math.max(start, 0);

  if (stop < start) return { entries: [], total: total };

  var names = (await client.zRange(sortKey, start, stop)).map(key.nameOfSorted);

  if (descending) names.reverse();

  var packed = names.length
    ? await client.hmGet(key.dir(blogID, dir), names)
    : [];
  var entries = [];

  names.forEach(function (name, i) {
    if (packed[i] !== null && packed[i] !== undefined)
      entries.push(Object.assign({ name: name }, parse(packed[i])));
  });

  return { entries: entries, total: total };
}

// An async iterator of { path, type } for everything below dir, read from
// the directories' hashes, one directory at a time: each directory comes
// before what is in it, and siblings in byte order of their names. Yields
// nothing for a missing directory, or a file.
async function* descend(blogID, dir) {
  var entries = (await scan(blogID, dir)).sort(function (a, b) {
    return key.compareSorted(a.name, b.name);
  });

  for (var entry of entries) {
    var path = child(dir, entry.name);

    yield { path: path, type: entry.type };

    if (entry.type === "dir") yield* descend(blogID, path);
  }
}

// An async iterator of every path below dir (files and directories), each
// directory before what is in it and siblings in byte order. It costs a read
// per directory, so it is for moves, removals, rebuilds and scripts. Yields
// nothing for a missing directory.
async function* subtree(blogID, dir) {
  check(blogID);

  for await (var found of descend(blogID, normalize(dir))) yield found.path;
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
    var match = joined
      ? caseSensitivePath.pick(joined.split("/"), segment)
      : undefined;

    if (match === undefined) return null;

    current = child(current, match);
  }

  return current;
}

// { bytes, files } for the whole folder
async function totals(blogID) {
  check(blogID);

  var [bytes, files] = await client.hmGet(key.totals(blogID), [
    "bytes",
    "files",
  ]);

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

  for (const item of items) {
    var path = normalize(item.path);

    if (path === "/")
      throw new Error("models/file: the folder itself has no record");

    // The sorted sets end a member's sort key with NUL (key.sortMember)
    if (path.indexOf("\u0000") !== -1)
      throw new Error("models/file: a path cannot contain NUL");

    // Packed now so a bad record fails before anything is read
    pack(item);

    // A file and a directory at one path, as a listing could hold
    if (wanted.has(path) && wanted.get(path).type !== item.type) {
      throw failure(
        item.type === "dir" ? "EEXIST" : "EISDIR",
        "A file and a directory at: " + path
      );
    }

    wanted.set(path, item);
  }

  var ancestors = new Set();

  for (const path of wanted.keys()) {
    for (const ancestor of ancestorsOf(path)) {
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

  for (const ancestor of ancestors) {
    const found = existing.get(ancestor);

    if (found && found.type !== "dir")
      throw failure("ENOTDIR", "Not a directory: " + ancestor);
    if (!found)
      writes.set(ancestor, { type: "dir", size: 0, modified: now, sha1: "" });
  }

  for (const [path, item] of wanted) {
    const found = existing.get(path);

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

  for (const path of writes.keys()) {
    if (existing.get(path)) continue;

    var lowerKey = key.lower(blogID, parentOf(path));
    var folded = fold(nameOf(path));
    var id = lowerKey + "\n" + folded;

    if (!added.has(id))
      added.set(id, { lowerKey: lowerKey, folded: folded, names: [] });

    added.get(id).names.push(nameOf(path));
  }

  var lookups = [...added.values()];
  var current = await Promise.all(
    lookups.map(function (lookup) {
      return client.hGet(lookup.lowerKey, lookup.folded);
    })
  );

  // The sorted sets which gain a child. A directory which already had a hash
  // but has no sorted set yet gets them built from its hash in the same
  // exec, so a set, once there, is complete; adding just the new child would
  // leave it partial. Whether the first order's set exists decides, since
  // they are always built together.
  var sorted = new Map();

  for (const [path, record] of writes) {
    if (existing.get(path)) continue;

    var parent = parentOf(path);

    if (!sorted.has(parent)) sorted.set(parent, []);

    sorted.get(parent).push({ name: nameOf(path), type: record.type });
  }

  // A directory new in this call has no hash to build from
  var older = [...sorted.keys()].filter(function (dir) {
    return dir === "/" || !!existing.get(dir);
  });

  await Promise.all(
    older.map(async function (dir) {
      if (await client.exists(sortKeys(blogID, dir)[0])) return;

      for (const entry of await scan(blogID, dir)) sorted.get(dir).push(entry);
    })
  );

  var multi = client.multi();

  for (const [dir, children] of sorted) addSorted(multi, blogID, dir, children);
  var bytes = 0;
  var files = 0;

  for (const [path, record] of writes) {
    var previous = existing.get(path);

    multi.hSet(key.dir(blogID, parentOf(path)), nameOf(path), pack(record));

    if (record.type === "file") {
      bytes += (Number(record.size) || 0) - (previous ? previous.size : 0);
      if (!previous) files += 1;
    }
  }

  lookups.forEach(function (lookup, i) {
    var joined = current[i];

    for (const name of lookup.names) joined = updateNames(joined, name, true);

    setNames(multi, lookup.lowerKey, lookup.folded, joined);
  });

  if (bytes) multi.hIncrBy(key.totals(blogID), "bytes", bytes);
  if (files) multi.hIncrBy(key.totals(blogID), "files", files);

  await multi.exec();
}

// Records one path: record is { type, size, modified, sha1, flags }
function set(blogID, path, record) {
  return setMany(blogID, [Object.assign({}, record, { path: path })]);
}

// Replaces one source's flags on a file's record (flags.js), leaving its
// bytes' fields and other sources' flags as they are. With { sha1 }, only if
// the record still describes those bytes, so a writer which read the file
// earlier can't flag newer bytes it never saw. Resolves to true if the
// record was changed, false if there is no such file or its sha1 differs.
// A read then a write, safe under the sync lock like every other write here.
async function setFlags(blogID, path, source, list, options) {
  check(blogID);
  path = normalize(path);

  if (path === "/") return false;

  var dirKey = key.dir(blogID, parentOf(path));
  var found = parse(await client.hGet(dirKey, nameOf(path)));

  if (!found || found.type !== "file") return false;

  var sha1 = options && options.sha1;

  if (sha1 && found.sha1 && found.sha1 !== sha1) return false;

  var next = flags.replace(found.flags, source, list);

  if (JSON.stringify(next) === JSON.stringify(found.flags || [])) return true;

  found.flags = next;

  await client.hSet(dirKey, nameOf(path), pack(found));

  return true;
}

// Stores a SHA-1 a reader computed for a file whose record has none (an
// index rebuilt without hashing), so the next listing has it for free. Only
// while the record still describes the bytes that were read: the same size
// and modified time, and still no SHA-1. Resolves to whether it stored it.
async function fillSha1(blogID, path, read, sha1) {
  check(blogID);
  path = normalize(path);

  if (path === "/" || !/^[0-9a-f]{40}$/.test(sha1 || "")) return false;

  var dirKey = key.dir(blogID, parentOf(path));
  var found = parse(await client.hGet(dirKey, nameOf(path)));

  if (
    !found ||
    found.type !== "file" ||
    found.sha1 ||
    found.size !== read.size ||
    found.modified !== read.modified
  )
    return false;

  found.sha1 = sha1;
  await client.hSet(dirKey, nameOf(path), pack(found));
  return true;
}

// An async iterator of { path, ...record } for every file below dir which
// has flags. Reads each directory's hash once, so it costs a pass over the
// whole subtree: for rebuilds and scripts, not for requests.
async function* flagged(blogID, dir) {
  check(blogID);

  var pending = [normalize(dir)];

  while (pending.length) {
    var current = pending.shift();

    for (var entry of await scan(blogID, current)) {
      var path = child(current, entry.name);

      if (entry.type === "dir") pending.push(path);
      else if (entry.flags && entry.flags.length) {
        var found = Object.assign({ path: path }, entry);
        delete found.name;
        yield found;
      }
    }
  }
}

// Forgets everything below a directory, deepest first, a HSCAN page of its
// hash at a time: the page's subdirectories are emptied first, then the
// page's children removed, so each file's size is still in its parent's hash
// when it is counted, and only a page per level of depth is held. Removing
// what a scan already returned never makes it miss a field still there. If
// this stops part way, what is left is still a consistent subtree, except
// that a parent's lowercased lookup may name a child already gone, until the
// parent itself goes; the reconcile repairs that.
async function removeBelow(blogID, dir) {
  var cursor = "0";

  do {
    var reply = await client.hScan(key.dir(blogID, dir), cursor, {
      COUNT: PAGE,
    });
    var page = reply.entries.map(function (entry) {
      return Object.assign({ name: entry.field }, parse(entry.value));
    });

    cursor = String(reply.cursor);

    for (var entry of page)
      if (entry.type === "dir")
        await removeBelow(blogID, child(dir, entry.name));

    if (!page.length) continue;

    var multi = client.multi();
    var bytes = 0;
    var files = 0;

    for (var found of page) {
      if (found.type === "file") {
        bytes += found.size;
        files += 1;
      } else {
        var path = child(dir, found.name);

        multi.del([
          key.dir(blogID, path),
          key.lower(blogID, path),
          key.names(blogID, path),
          ...sortKeys(blogID, path),
        ]);
      }

      multi.hDel(key.dir(blogID, dir), found.name);
      removeSorted(multi, blogID, dir, found.name);
    }

    if (bytes) multi.hIncrBy(key.totals(blogID), "bytes", -bytes);
    if (files) multi.hIncrBy(key.totals(blogID), "files", -files);

    await multi.exec();
  } while (cursor !== "0");
}

// Forgets a file, or a directory and everything below it. Resolves to the
// record which was removed, or null if there was none.
async function remove(blogID, path) {
  check(blogID);
  path = normalize(path);

  if (path === "/")
    throw new Error("models/file: remove needs a path inside the folder");

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
  removeSorted(multi, blogID, parent, name);
  setNames(multi, lowerKey, folded, updateNames(joined, name, false));

  if (record.type === "dir") {
    multi.del([
      key.dir(blogID, path),
      key.lower(blogID, path),
      key.names(blogID, path),
      ...sortKeys(blogID, path),
    ]);
  } else {
    if (record.size) multi.hIncrBy(key.totals(blogID), "bytes", -record.size);
    multi.hIncrBy(key.totals(blogID), "files", -1);
  }

  await multi.exec();

  return record;
}

// Forgets the whole folder, for blog deletion and before a rebuild. Every
// directory is found first, then their keys deleted a page at a time (a
// directory's hash must still be there when the walk reaches it).
async function removeAll(blogID) {
  check(blogID);

  var dirs = ["/"];

  for await (var found of descend(blogID, "/"))
    if (found.type === "dir") dirs.push(found.path);

  for (var i = 0; i < dirs.length; i += PAGE) {
    var keys = [];

    for (var path of dirs.slice(i, i + PAGE))
      keys.push(
        key.dir(blogID, path),
        key.lower(blogID, path),
        key.names(blogID, path),
        ...sortKeys(blogID, path)
      );

    await client.del(keys);
  }

  await client.del([key.paths(blogID), key.totals(blogID)]);
}

// Checks a directory's sorted set for one order against its hash, a page
// at a time: { expected, present, card, bytes, longest }, where expected is
// how many children belong in the set, present how many of them it holds,
// card how many members it has, and bytes and longest the total and the
// largest member's size in bytes.
async function compareSorted(blogID, dir, order) {
  var setKey = key.sort(blogID, order.name, dir);
  var card = await client.zCard(setKey);
  var found = { expected: 0, present: 0, card: card, bytes: 0, longest: 0 };
  var cursor = "0";

  do {
    var reply = await client.hScan(key.dir(blogID, dir), cursor, {
      COUNT: PAGE,
    });
    var members = [];

    for (var entry of reply.entries) {
      var item = Object.assign({ name: entry.field }, parse(entry.value));

      if (!order.holds(item)) continue;

      var member = order.member(item.name);
      var size = Buffer.byteLength(member);

      members.push(member);
      found.bytes += size;
      found.longest = Math.max(found.longest, size);
    }

    found.expected += members.length;

    if (card && members.length) {
      for (var score of await client.zmScore(setKey, members))
        if (score !== null && score !== undefined) found.present++;
    }

    cursor = String(reply.cursor);
  } while (cursor !== "0");

  return found;
}

// Replaces a directory's sorted set for one order with one built from its
// hash. It is built under another key a page at a time, then renamed over
// the set in one exec, so a run stopped part way leaves the old set or the
// new one, never a partial set. An empty directory just loses its set.
async function rebuildSorted(blogID, dir, order) {
  var setKey = key.sort(blogID, order.name, dir);
  var buildKey = key.sortBuild(blogID, order.name, dir);
  var built = 0;
  var cursor = "0";

  await client.del(buildKey);

  do {
    var reply = await client.hScan(key.dir(blogID, dir), cursor, {
      COUNT: PAGE,
    });
    var members = [];

    for (var entry of reply.entries) {
      var item = Object.assign({ name: entry.field }, parse(entry.value));

      if (order.holds(item))
        members.push({ score: 0, value: order.member(item.name) });
    }

    if (members.length) await client.zAdd(buildKey, members);

    built += members.length;
    cursor = String(reply.cursor);
  } while (cursor !== "0");

  var multi = client.multi();

  if (built) multi.rename(buildKey, setKey);
  else multi.del([buildKey, setKey]);

  await multi.exec();
}

// An async iterator over every directory of a blog, checking each of its
// sorted sets (sorts.js, or only options.order) against its hash. Yields
// { dir, order, state, expected, card, bytes, longest } per directory and
// order, where state is "ok", "missing" (no set, though the directory has
// children) or "mismatched" (the set lacks a child or holds a member that
// isn't one). The setMany above keeps the sets complete, but code from
// before them, running beside it during a deploy or after a rollback,
// changes a directory without them; this finds every such directory.
//
// With options.apply, a set which isn't ok is rebuilt (rebuildSorted), and
// the yielded state is still what was found. Run it under the blog's sync
// lock then: a write between reading a hash and renaming its set into place
// would be lost from the set. One directory is held at a time, a page of it.
async function* checkSorts(blogID, options) {
  check(blogID);

  var apply = !!(options && options.apply);
  var orders = SORTS.filter(function (order) {
    return !options || !options.order || order.name === options.order;
  });

  if (!orders.length)
    throw new Error("models/file: no such order: " + options.order);

  var queue = ["/"];

  while (queue.length) {
    var dir = queue.pop();
    var cursor = "0";

    do {
      var reply = await client.hScan(key.dir(blogID, dir), cursor, {
        COUNT: PAGE,
      });

      for (var entry of reply.entries)
        if (parse(entry.value).type === "dir")
          queue.push(child(dir, entry.field));

      cursor = String(reply.cursor);
    } while (cursor !== "0");

    for (const order of orders) {
      var found = await compareSorted(blogID, dir, order);
      var state =
        found.card === 0 && found.expected > 0
          ? "missing"
          : found.card !== found.expected || found.present !== found.expected
            ? "mismatched"
            : "ok";

      if (apply && state !== "ok") await rebuildSorted(blogID, dir, order);

      yield {
        dir: dir,
        order: order.name,
        state: state,
        expected: found.expected,
        card: found.card,
        bytes: found.bytes,
        longest: found.longest,
      };
    }
  }
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
          counts.skipped.push({
            path: normalize(record.path),
            type: record.type,
            code: err.code,
          });
        }
      }
    }

    batch = [];
  }

  // A listing knows nothing of flags, so the flags of a file whose bytes are
  // unchanged (the same size, and the same SHA-1 where both are known) are
  // carried over to its new record
  var kept = new Map();

  for await (var previous of flagged(blogID, "/"))
    kept.set(previous.path, previous);

  await removeAll(blogID);

  for await (var record of records) {
    var before = kept.get(normalize(record.path));

    if (
      before &&
      record.type === "file" &&
      !record.flags &&
      Number(record.size) === before.size &&
      (!record.sha1 || !before.sha1 || record.sha1 === before.sha1)
    ) {
      record = Object.assign({}, record, { flags: before.flags });
    }

    batch.push(record);

    if (batch.length >= 500) await flush();
  }

  if (batch.length) await flush();

  var sum = await totals(blogID);

  counts.files = sum.files;
  counts.bytes = sum.bytes;

  for await (var found of descend(blogID, "/"))
    if (found.type === "dir") counts.dirs += 1;

  return counts;
}

module.exports = {
  key,
  flags,
  normalize,
  get,
  list,
  pages,
  listAll,
  range,
  subtree,
  resolveCaseInsensitive,
  totals,
  set,
  setMany,
  setFlags,
  fillSha1,
  flagged,
  remove,
  removeAll,
  rebuild,
  checkSorts,
};
