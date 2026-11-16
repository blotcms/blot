// One-off Redis cleanups for data which past code, or a removal that failed,
// left behind (#2760). Each subcommand is report-only unless --apply, prints
// counts (and an estimate of the bytes, from MEMORY USAGE on a sample), and is
// safe to rerun.
//
//   node scripts/storage/redis-vestiges.js <subcommand> [--apply] [--only <x>]
//
// Subcommands, and what each removes (why it is safe):
//
//   deleted-entries  gives deleted entries with no TTL the TTL Entry.set gives
//                    a deleted entry, and scores them in the blog's "deleted"
//                    list, so sweepExpiredDeleted removes their ids from the
//                    lists once they expire (they predate that TTL)
//   deleted-blogs    deletes blog:<id>:* and template:<id>:* of blogs which
//                    have no info and are not in the blogs set (a removal which
//                    failed part way); the bucket and Bunny are not touched
//   dropbox-members  removes blog IDs from clients:dropbox:<account> sets
//                    when the blog is gone (the set vanishes when empty)
//   template-shares  deletes template:share:<id> when the template it names
//                    has no metadata (the template was dropped)
//   permalinks       deletes blog:<id>:url:<url> keys whose entry key is gone.
//                    A key whose entry exists stays, even when the entry has
//                    another URL now or is deleted: that is a redirect, the
//                    entry route 301s to the entry's canonical URL
//   rendered         deletes cdn:rendered:<hash> which no template's cdn
//                    metadata references (an old hash cleanup which failed)
//   ssl              deletes ssl:<domain>:latest when it has expired and the
//                    domain has no domain:<domain> key (auto-ssl only renews
//                    domains which have one), or is a subdomain of the host,
//                    which the wildcard certificate covers. Only :latest is
//                    deleted, it is the only auto-ssl key we can see in proxy/
//   removed-features runs remove-ignored-files.js and
//                    remove-file-index-names.js (keys of removed features)
//   all              every subcommand in turn
//
// --only <x> narrows a subcommand to one blog ID, account ID, share ID, hash
// or domain: the part of the key pattern which would be a * (for tests, and
// for trying a run on one blog).
//
// Keys are found with SCAN ... COUNT 100, never KEYS, and TYPE is checked
// before any read. SCAN may return a key twice, so counts can run a little
// high; deleting is idempotent. Writes go in multi()s of a few hundred
// commands.

const config = require("config");
const client = require("models/client");
const Blog = require("models/blog");
const entryKey = require("models/entry/key");
const templateKey = require("models/template/key");
const folderLock = require("sync/lock");
const {
  DELETED_ENTRY_TTL_SECONDS,
} = require("models/entries/sweepExpiredDeleted");
const { expiryOf } = require("scheduler/check-ssl-certificates");
const removeIgnoredFiles = require("./remove-ignored-files");
const removeFileIndexNames = require("./remove-file-index-names");

const SCAN_COUNT = 100;
const BATCH = 200;
const SAMPLE = 50;
const BLOG_ID = /^blog_[a-f0-9]+$/;
const NO_ENTRY = "blot:no-such-entry";

// Yields the keys of each page of a SCAN
async function* scan(pattern) {
  let cursor = "0";

  do {
    const reply = await client.scan(cursor, {
      MATCH: pattern,
      COUNT: SCAN_COUNT,
    });

    if (!reply || typeof reply !== "object")
      throw new Error("Unexpected SCAN reply: " + JSON.stringify(reply));

    cursor = String(reply.cursor);

    if (reply.keys.length) yield reply.keys;
  } while (cursor !== "0");
}

// The keys of the given type, from a page of keys
async function ofType(keys, type) {
  const multi = client.multi();
  for (const key of keys) multi.type(key);
  const found = await multi.exec();
  return keys.filter((key, i) => found[i] === type);
}

// GETs string keys. Through sendCommand: client-side caching is on for this
// client, and these values would crowd out entries which are worth caching.
function mget(keys) {
  return client.sendCommand(["MGET", ...keys]);
}

// Estimates the bytes of the keys counted by adding up MEMORY USAGE for the
// first few and scaling to the count
function sampler() {
  const sample = { count: 0, bytes: 0 };

  return {
    async add(key) {
      if (sample.count >= SAMPLE) return;

      const used = await client.sendCommand(["MEMORY", "USAGE", key]);

      if (typeof used === "number") {
        sample.count++;
        sample.bytes += used;
      }
    },
    estimate(total) {
      return sample.count
        ? Math.round((sample.bytes / sample.count) * total)
        : 0;
    },
  };
}

function size(n) {
  return n < 1024 * 1024
    ? Math.round(n / 1024) + " KiB"
    : (n / 1024 / 1024).toFixed(1) + " MiB";
}

function verb(apply, done, would) {
  return apply ? done : would;
}

// ---- deleted-entries ----

const ENTRY_KEY = /^blog:([^:]+):entry:(.+)$/s;

// What Entry.set does for a deleted entry: the TTL on the key, and (Entry's
// list assignment, models/entry/_assign.js) its id in the "deleted" list
// scored with the time. The entry is read again first, so one saved again
// since the scan is left alone. Resolves true when it fixed the entry.
async function fixDeletedEntry(blogID, key, suffix) {
  if ((await client.type(key)) !== "string") return false;
  if ((await client.ttl(key)) !== -1) return false;

  let entry;

  try {
    entry = JSON.parse(await client.get(key));
  } catch (err) {
    return false;
  }

  if (!entry || entry.deleted !== true) return false;

  // The id the lists hold is the entry's id, its normalized path
  const id = typeof entry.id === "string" && entry.id ? entry.id : suffix;

  const [expired] = await client
    .multi()
    .expire(key, DELETED_ENTRY_TTL_SECONDS)
    .zAdd("blog:" + blogID + ":deleted", { score: Date.now(), value: id })
    .exec();

  return !!expired;
}

async function deletedEntries({ apply = false, only = "*" } = {}) {
  const result = { scanned: 0, found: 0, fixed: 0, estimatedBytes: 0 };
  const sample = sampler();

  for await (const page of scan("blog:" + only + ":entry:*")) {
    const strings = await ofType(page, "string");

    if (!strings.length) continue;

    const multi = client.multi();
    for (const key of strings) multi.ttl(key);
    const ttl = await multi.exec();
    const persistent = strings.filter((key, i) => ttl[i] === -1);

    result.scanned += strings.length;

    if (!persistent.length) continue;

    const values = await mget(persistent);

    for (let i = 0; i < persistent.length; i++) {
      const key = persistent[i];
      const match = ENTRY_KEY.exec(key);
      let entry;

      try {
        entry = JSON.parse(values[i]);
      } catch (err) {
        continue;
      }

      if (!match || !entry || entry.deleted !== true) continue;

      result.found++;
      await sample.add(key);

      if (apply && (await fixDeletedEntry(match[1], key, match[2])))
        result.fixed++;
    }
  }

  result.estimatedBytes = sample.estimate(result.found);

  console.log(
    "deleted-entries: " +
      result.found +
      " deleted entries with no TTL, of " +
      result.scanned +
      " entries scanned, about " +
      size(result.estimatedBytes) +
      ". " +
      verb(apply, "Gave " + result.fixed + " a TTL", "Would give them a TTL")
  );

  return result;
}

// ---- deleted-blogs ----

const BLOG_KEY = /^(?:blog|template):(blog_[a-f0-9]+):/;
const OWNED_KEY =
  /^template:(?:owned_by|folder_pending_removal|folder_fresh):(blog_[a-f0-9]+)$/;

async function blogExists(blogID) {
  if (await client.exists("blog:" + blogID + ":info")) return true;
  return !!(await client.sIsMember(Blog.key.ids, blogID));
}

// Deletes the keys Blog.remove's deleteKeys does (the same patterns; the
// folder lock stays, its holder releases it or it expires) for a blog which
// is still gone. The handle and domain keys need the blog's info, which is
// gone, so they are not touched.
async function deleteBlogKeys(blogID) {
  // A blog created since the scan has its info and a place in the set
  if (await blogExists(blogID)) return 0;

  const lock = folderLock.key(blogID);
  const patterns = ["template:" + blogID + ":*", "blog:" + blogID + ":*"];
  let batch = [
    "template:owned_by:" + blogID,
    templateKey.folderPendingRemoval(blogID),
    templateKey.folderFresh(blogID),
  ];
  let deleted = 0;

  async function flush() {
    if (batch.length) deleted += await client.del(batch);
    batch = [];
  }

  for (const pattern of patterns) {
    for await (const page of scan(pattern)) {
      for (const key of page) if (key !== lock) batch.push(key);
      if (batch.length >= BATCH) await flush();
    }
  }

  await flush();

  return deleted;
}

async function deletedBlogs({ apply = false, only = "*" } = {}) {
  const counts = new Map(); // ID of a blog which is gone -> its keys
  const checked = new Map(); // blog ID -> whether it is gone
  const sample = sampler();
  const patterns = [
    "blog:" + only + ":*",
    "template:" + only + ":*",
    "template:owned_by:" + only,
    "template:folder_pending_removal:" + only,
    "template:folder_fresh:" + only,
  ];

  for (const pattern of patterns) {
    for await (const page of scan(pattern)) {
      for (const key of page) {
        const match = BLOG_KEY.exec(key) || OWNED_KEY.exec(key);

        if (!match || !BLOG_ID.test(match[1])) continue;

        const blogID = match[1];

        if (!checked.has(blogID))
          checked.set(blogID, !(await blogExists(blogID)));
        if (!checked.get(blogID)) continue;

        counts.set(blogID, (counts.get(blogID) || 0) + 1);
        await sample.add(key);
      }
    }
  }

  let total = 0;
  let deleted = 0;

  for (const [blogID, count] of counts) {
    total += count;
    console.log("  " + blogID + ": " + count + " keys");
  }

  if (apply)
    for (const blogID of counts.keys()) deleted += await deleteBlogKeys(blogID);

  console.log(
    "deleted-blogs: " +
      counts.size +
      " blogs which are gone have " +
      total +
      " keys, about " +
      size(sample.estimate(total)) +
      ". " +
      verb(apply, "Deleted " + deleted + " keys", "Would delete them")
  );

  return { blogs: Array.from(counts.keys()).sort(), keys: total, deleted };
}

// ---- dropbox-members ----

async function goneBlogs(ids) {
  const gone = [];
  for (const id of ids)
    if (!(await client.exists("blog:" + id + ":info"))) gone.push(id);
  return gone;
}

async function dropboxMembers({ apply = false, only = "*" } = {}) {
  const result = { sets: 0, members: 0, stale: 0, removed: 0 };

  for await (const page of scan("clients:dropbox:" + only)) {
    for (const key of await ofType(page, "set")) {
      const members = await client.sMembers(key);
      const stale = await goneBlogs(members);

      result.sets++;
      result.members += members.length;
      result.stale += stale.length;

      if (!apply || !stale.length) continue;

      // Checked again, so a blog created since the read is kept
      const again = await goneBlogs(stale);

      if (again.length) result.removed += await client.sRem(key, again);
    }
  }

  console.log(
    "dropbox-members: " +
      result.stale +
      " of " +
      result.members +
      " members of " +
      result.sets +
      " sets name blogs which are gone. " +
      verb(apply, "Removed " + result.removed, "Would remove them")
  );

  return result;
}

// ---- template-shares ----

async function templateShares({ apply = false, only = "*" } = {}) {
  const result = { scanned: 0, stale: 0, deleted: 0 };

  for await (const page of scan("template:share:" + only)) {
    const strings = await ofType(page, "string");
    if (!strings.length) continue;

    const targets = await mget(strings);

    for (let i = 0; i < strings.length; i++) {
      const key = strings[i];
      const target = targets[i];

      result.scanned++;

      if (target && (await client.exists(templateKey.metadata(target))))
        continue;

      result.stale++;

      if (!apply) continue;

      // Not deleted if it names another template now, or its template is back
      const now = await client.get(key);

      if (now !== target) continue;
      if (now && (await client.exists(templateKey.metadata(now)))) continue;

      result.deleted += await client.del(key);
    }
  }

  console.log(
    "template-shares: " +
      result.stale +
      " of " +
      result.scanned +
      " shares name a template which is gone. " +
      verb(apply, "Deleted " + result.deleted, "Would delete them")
  );

  return result;
}

// ---- permalinks ----

const URL_KEY = /^blog:([^:]+):url:/;

// The entry key a permalink's value names
function entryKeyFor(key, value) {
  const match = URL_KEY.exec(key);

  if (!match || typeof value !== "string" || !value) return NO_ENTRY;

  try {
    return entryKey.entry(match[1], value);
  } catch (err) {
    return NO_ENTRY;
  }
}

async function existsAll(keys) {
  const multi = client.multi();
  for (const key of keys) multi.exists(key);
  return multi.exec();
}

async function permalinks({ apply = false, only = "*" } = {}) {
  const result = { scanned: 0, stale: 0, deleted: 0, estimatedBytes: 0 };
  const sample = sampler();
  let pending = []; // [permalink key, value]

  // Deletes the pending keys whose entry is still gone, and which still hold
  // the value read: the entry may have come back since the scan
  async function flush() {
    if (!pending.length) return;

    const multi = client.multi();
    for (const [key, value] of pending) {
      multi.get(key);
      multi.exists(entryKeyFor(key, value));
    }
    const replies = await multi.exec();
    const del = client.multi();
    let count = 0;

    pending.forEach(([key, value], i) => {
      if (replies[i * 2] !== value || replies[i * 2 + 1]) return;
      del.del(key);
      count++;
    });

    if (count) await del.exec();

    result.deleted += count;
    pending = [];
  }

  for await (const page of scan("blog:" + only + ":url:*")) {
    const strings = await ofType(page, "string");
    if (!strings.length) continue;

    const values = await mget(strings);
    const exists = await existsAll(
      strings.map((key, i) => entryKeyFor(key, values[i]))
    );

    for (let i = 0; i < strings.length; i++) {
      result.scanned++;

      if (exists[i]) continue;

      result.stale++;
      await sample.add(strings[i]);

      if (apply) pending.push([strings[i], values[i]]);
      if (pending.length >= BATCH) await flush();
    }
  }

  await flush();

  result.estimatedBytes = sample.estimate(result.stale);

  console.log(
    "permalinks: " +
      result.stale +
      " of " +
      result.scanned +
      " permalink keys name an entry which is gone, about " +
      size(result.estimatedBytes) +
      ". Keys whose entry exists stay (redirects). " +
      verb(apply, "Deleted " + result.deleted, "Would delete them")
  );

  return result;
}

// ---- rendered ----

const RENDERED = "cdn:rendered:";

// The hashes which templates' cdn manifests reference as rendered views (a
// folder file's entry is an object, with no rendered output)
async function referencedHashes() {
  const referenced = new Set();

  for await (const page of scan("template:*:info")) {
    for (const key of await ofType(page, "hash")) {
      let manifest;

      try {
        manifest = JSON.parse((await client.hGet(key, "cdn")) || "{}");
      } catch (err) {
        // Unreadable, so it can't be said what the template references:
        // stop rather than delete something it uses
        throw new Error("Unreadable cdn manifest in " + key, { cause: err });
      }

      if (!manifest || typeof manifest !== "object") continue;

      for (const hash of Object.values(manifest))
        if (typeof hash === "string") referenced.add(hash);
    }
  }

  return referenced;
}

async function rendered({ apply = false, only = "*" } = {}) {
  const result = { scanned: 0, unreferenced: 0, deleted: 0, estimatedBytes: 0 };
  const sample = sampler();
  let candidates = [];

  // Candidates first, then the references: an output written after the scan
  // is not a candidate, and one written before it is already referenced
  for await (const page of scan(RENDERED + only))
    candidates = candidates.concat(await ofType(page, "string"));

  result.scanned = candidates.length;

  const unreferenced = async () => {
    const referenced = await referencedHashes();
    return candidates.filter(
      (key) => !referenced.has(key.slice(RENDERED.length))
    );
  };

  let stale = await unreferenced();

  result.unreferenced = stale.length;

  for (const key of stale.slice(0, SAMPLE)) await sample.add(key);

  if (apply && stale.length) {
    // Read again right before deleting
    stale = await unreferenced();

    for (let i = 0; i < stale.length; i += BATCH)
      result.deleted += await client.del(stale.slice(i, i + BATCH));
  }

  result.estimatedBytes = sample.estimate(result.unreferenced);

  console.log(
    "rendered: " +
      result.unreferenced +
      " of " +
      result.scanned +
      " rendered outputs are referenced by no template, about " +
      size(result.estimatedBytes) +
      ". " +
      verb(apply, "Deleted " + result.deleted, "Would delete them")
  );

  return result;
}

// ---- ssl ----

async function ssl({ apply = false, only = "*", now = Date.now() } = {}) {
  const result = { scanned: 0, stale: 0, deleted: 0, unreadable: 0 };
  const stale = [];

  for await (const page of scan("ssl:" + only + ":latest")) {
    const strings = await ofType(page, "string");
    if (!strings.length) continue;

    const values = await mget(strings);

    for (let i = 0; i < strings.length; i++) {
      const domain = strings[i].slice("ssl:".length, -":latest".length);
      let expires;

      result.scanned++;

      try {
        expires = expiryOf(values[i]);
      } catch (err) {
        result.unreadable++;
        continue;
      }

      if (expires >= now) continue;

      // A subdomain of the host uses the wildcard certificate; any other
      // domain is only renewed while it has a domain key
      if (
        domain.endsWith("." + config.host) ||
        !(await client.exists("domain:" + domain))
      )
        stale.push(strings[i]);
    }
  }

  result.stale = stale.length;

  if (apply) {
    for (const key of stale) {
      // Not deleted if it was renewed since the scan
      try {
        if (expiryOf(await client.get(key)) < now)
          result.deleted += await client.del(key);
      } catch (err) {
        continue;
      }
    }
  }

  console.log(
    "ssl: " +
      result.stale +
      " of " +
      result.scanned +
      " certificates have expired and are not renewed" +
      (result.unreadable
        ? "; " + result.unreadable + " unreadable, left alone"
        : "") +
      ". " +
      verb(apply, "Deleted " + result.deleted, "Would delete them")
  );

  return result;
}

// ---- removed-features ----

async function removedFeatures({ apply = false, only } = {}) {
  const ids = only ? [only] : await Blog.getAllIDs();
  const result = { ignoredFiles: 0, fileIndexNames: 0 };

  for (const blogID of ids) {
    const ignored = await removeIgnoredFiles.removeFor(blogID, apply);

    if (ignored && !ignored.type) result.ignoredFiles++;

    result.fileIndexNames += await removeFileIndexNames.removeNames(
      blogID,
      apply
    );
  }

  console.log(
    "removed-features: " +
      result.ignoredFiles +
      " ignored_files hashes and " +
      result.fileIndexNames +
      " file index names sets, of " +
      ids.length +
      " blogs. " +
      verb(apply, "Removed them", "Would remove them")
  );

  return result;
}

const SUBCOMMANDS = {
  "deleted-entries": deletedEntries,
  "deleted-blogs": deletedBlogs,
  "dropbox-members": dropboxMembers,
  "template-shares": templateShares,
  permalinks,
  rendered,
  ssl,
  "removed-features": removedFeatures,
};

async function all(options) {
  const results = {};

  for (const name of Object.keys(SUBCOMMANDS))
    results[name] = await SUBCOMMANDS[name](options);

  return results;
}

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/redis-vestiges.js <" +
      Object.keys(SUBCOMMANDS).concat("all").join("|") +
      "> [--apply] [--only <x>]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false };
  let name;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--only" && argv[i + 1]) options.only = argv[++i];
    else if (!name && !argv[i].startsWith("--")) name = argv[i];
    else usage("Unknown argument: " + argv[i]);
  }

  if (name !== "all" && !SUBCOMMANDS[name]) usage("Unknown subcommand");

  return { name, options };
}

module.exports = {
  all,
  deletedEntries,
  deletedBlogs,
  dropboxMembers,
  templateShares,
  permalinks,
  rendered,
  ssl,
  removedFeatures,
};

if (require.main === module) {
  const { name, options } = parse(process.argv.slice(2));
  const run = name === "all" ? all : SUBCOMMANDS[name];

  run(options).then(
    function () {
      if (!options.apply)
        console.log("Dry run: pass --apply to make the changes");
      process.exit(0);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
}
