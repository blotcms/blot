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
//                    lists once they expire (they predate that TTL). It pages
//                    through each blog's "deleted" list and reads an entry
//                    only when its TTL is -1; it never reads live entries. A
//                    deleted entry missing from that list is not found (that
//                    would mean reading every entry); Entry.set always adds
//                    a deleted entry to it
//   deleted-blogs    deletes blog:<id>:* and template:<id>:* of blogs which
//                    have no info and are not in the blogs set (a removal which
//                    failed part way); the bucket and Bunny are not touched
//   dropbox-members  removes blog IDs from clients:dropbox:<account> sets
//                    when the blog is gone, is on another client, or its
//                    Dropbox account is another or missing (webhooks only
//                    sync a member whose account matches, so it is never
//                    used). The set vanishes when empty: so does the legacy
//                    clients:dropbox:undefined, whose members can match no
//                    account
//   dropbox-accounts deletes blog:<id>:dropbox:account and :access-token of
//                    blogs which still exist but are on another client (a
//                    disconnect which failed part way), and the blog's
//                    membership of its account's set: the tokens they hold
//                    are never used again. Looked at again 5 seconds later,
//                    since disconnect clears the client just before the
//                    account
//   dropbox-legacy   deletes the dropbox:<user id> sets of the old Dropbox
//                    client (API v1 user IDs), which no code reads
//   template-shares  deletes template:share:<id> when the template it names
//                    has no metadata (the template was dropped)
//   permalinks       deletes blog:<id>:url:<url> keys whose entry key is gone,
//                    after looking again 5 seconds later (Entry.set writes the
//                    url key before the entry key). A key whose entry exists
//                    stays, even when the entry has another URL now or is
//                    deleted: that is a redirect, the entry route 301s to the
//                    entry's canonical URL. A key whose name can't be read is
//                    skipped
//   rendered         deletes cdn:rendered:<hash> which no template's cdn
//                    metadata references on two reads a minute apart (an old
//                    hash cleanup which failed)
//   ssl              deletes ssl:<domain>:latest when it has expired and the
//                    domain has no domain:<domain> key (auto-ssl only renews
//                    domains which have one), or is a subdomain of the host,
//                    which the wildcard certificate covers. Only :latest is
//                    deleted, it is the only auto-ssl key we can see in proxy/
//   all              every subcommand above in turn
//
// The keys of removed features are not here: run remove-ignored-files.js and
// remove-file-index-names.js on their own, they pace themselves and handle
// the folder lock.
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

const SCAN_COUNT = 100;
const PAGE = 100;
const PAGE_PAUSE_MS = 5;
const BATCH = 200;
const SAMPLE = 50;
const BLOG_ID = /^blog_[a-f0-9]+$/;
const PERMALINK_WAIT_MS = 5000;
const PERMALINK_BATCH = 2000;
const RENDERED_WAIT_MS = 60000;

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// What Entry.set does for a deleted entry: the TTL on the key, and (Entry's
// list assignment, models/entry/_assign.js) its id in the "deleted" list
// scored with the time. The entry is read again first, so one saved again
// since the scan is left alone, and again after, so one saved again in
// between is put back as it was (no TTL, out of the "deleted" list).
// Resolves "fixed", "restored" or null (left alone).
async function fixDeletedEntry(blogID, key, id) {
  if ((await client.type(key)) !== "string") return null;
  if ((await client.ttl(key)) !== -1) return null;

  const isDeleted = async () => {
    try {
      return JSON.parse(await client.get(key)).deleted === true;
    } catch (err) {
      return false;
    }
  };

  if (!(await isDeleted())) return null;

  const list = "blog:" + blogID + ":deleted";

  await client
    .multi()
    .expire(key, DELETED_ENTRY_TTL_SECONDS)
    .zAdd(list, { score: Date.now(), value: id })
    .exec();

  if (await isDeleted()) return "fixed";

  // The file came back between the read and the write
  await client.multi().persist(key).zRem(list, id).exec();

  return "restored";
}

async function deletedEntries({ apply = false, only = "*" } = {}) {
  const result = {
    scanned: 0,
    found: 0,
    fixed: 0,
    restored: 0,
    estimatedBytes: 0,
  };
  const sample = sampler();
  const ids = only === "*" ? await Blog.getAllIDs() : [only];

  for (const blogID of ids) {
    const list = "blog:" + blogID + ":deleted";

    if ((await client.type(list)) !== "zset") continue;

    // A snapshot of the ids, taken before any is re-scored: fixing an entry
    // gives it a new score, which moves it within the sorted set and would
    // shift pages read by rank
    const all = await client.zRange(list, 0, -1);

    for (let start = 0; start < all.length; start += PAGE) {
      const members = all.slice(start, start + PAGE);

      const keys = members.map((id) => entryKey.entry(blogID, id));
      const multi = client.multi();
      for (const key of keys) multi.ttl(key);
      const ttl = await multi.exec();

      result.scanned += members.length;

      for (let i = 0; i < keys.length; i++) {
        if (ttl[i] !== -1) continue;
        if ((await client.type(keys[i])) !== "string") continue;

        let entry;

        try {
          entry = JSON.parse(await client.get(keys[i]));
        } catch (err) {
          continue;
        }

        if (!entry || entry.deleted !== true) continue;

        result.found++;
        await sample.add(keys[i]);

        if (!apply) continue;

        const outcome = await fixDeletedEntry(blogID, keys[i], members[i]);

        if (outcome === "fixed") result.fixed++;
        if (outcome === "restored") result.restored++;
      }

      await pause(PAGE_PAUSE_MS);
    }
  }

  result.estimatedBytes = sample.estimate(result.found);

  console.log(
    "deleted-entries: " +
      result.found +
      " deleted entries with no TTL, of " +
      result.scanned +
      " in the deleted lists, about " +
      size(result.estimatedBytes) +
      ". " +
      verb(
        apply,
        "Gave " +
          result.fixed +
          " a TTL; " +
          result.restored +
          " had come back, left alone",
        "Would give them a TTL"
      )
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

// Deletes the keys the scan found for a blog (the patterns Blog.remove's
// deleteKeys uses; the folder lock stays, its holder releases it or it
// expires) if the blog is still gone. The handle and domain keys need the
// blog's info, which is gone, so they are not touched.
async function deleteBlogKeys(blogID, keys) {
  // A blog created since the scan has its info and a place in the set
  if (await blogExists(blogID)) return 0;

  const lock = folderLock.key(blogID);
  const list = Array.from(keys).filter((key) => key !== lock);
  let deleted = 0;

  for (let i = 0; i < list.length; i += BATCH)
    deleted += await client.del(list.slice(i, i + BATCH));

  return deleted;
}

async function deletedBlogs({ apply = false, only = "*" } = {}) {
  const found = new Map(); // ID of a blog which is gone -> its keys
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

        if (!found.has(blogID)) found.set(blogID, new Set());

        found.get(blogID).add(key);
        await sample.add(key);
      }
    }
  }

  let total = 0;
  let deleted = 0;

  for (const [blogID, keys] of found) {
    total += keys.size;
    console.log("  " + blogID + ": " + keys.size + " keys");
  }

  if (apply)
    for (const [blogID, keys] of found)
      deleted += await deleteBlogKeys(blogID, keys);

  console.log(
    "deleted-blogs: " +
      found.size +
      " blogs which are gone have " +
      total +
      " keys, about " +
      size(sample.estimate(total)) +
      ". " +
      verb(apply, "Deleted " + deleted + " keys", "Would delete them")
  );

  return { blogs: Array.from(found.keys()).sort(), keys: total, deleted };
}

// ---- dropbox-members ----

const DROPBOX_RECHECK_MS = 5000;

// The members of the set of accountID which no webhook would sync
async function staleMembers(accountID, ids) {
  const stale = [];
  for (const id of ids) {
    if (!(await client.exists("blog:" + id + ":info"))) {
      stale.push(id);
      continue;
    }
    const blog = await Blog.get({ id }).catch(() => null);
    const account = await client.hGet(
      "blog:" + id + ":dropbox:account",
      "account_id"
    );
    if (!blog || blog.client !== "dropbox" || account !== accountID)
      stale.push(id);
  }
  return stale;
}

async function dropboxMembers({ apply = false, only = "*" } = {}) {
  const result = { sets: 0, members: 0, stale: 0, removed: 0 };

  for await (const page of scan("clients:dropbox:" + only)) {
    for (const key of await ofType(page, "set")) {
      const accountID = key.slice("clients:dropbox:".length);
      const members = await client.sMembers(key);
      const stale = await staleMembers(accountID, members);

      result.sets++;
      result.members += members.length;
      result.stale += stale.length;

      if (!apply || !stale.length) continue;

      // Checked again, so a blog connected since the read is kept
      const again = await staleMembers(accountID, stale);

      for (let i = 0; i < again.length; i += BATCH)
        result.removed += await client.sRem(key, again.slice(i, i + BATCH));
    }
  }

  console.log(
    "dropbox-members: " +
      result.stale +
      " of " +
      result.members +
      " members of " +
      result.sets +
      " sets name blogs which no webhook would sync. " +
      verb(apply, "Removed " + result.removed, "Would remove them")
  );

  return result;
}

// ---- dropbox-accounts ----

const ACCOUNT_KEY = /^blog:(blog_[a-f0-9]+):dropbox:account$/;

// The account_id of a blog's account left behind on another client, or null
async function leftAccount(key) {
  const blogID = key.match(ACCOUNT_KEY)[1];
  if (!(await client.exists("blog:" + blogID + ":info"))) return null;
  const blog = await Blog.get({ id: blogID }).catch(() => null);
  if (!blog || blog.client === "dropbox") return null;
  return { blogID, accountID: await client.hGet(key, "account_id") };
}

async function dropboxAccounts({
  apply = false,
  only = "*",
  recheckMs = DROPBOX_RECHECK_MS,
} = {}) {
  const result = { accounts: 0, left: 0, deleted: 0 };
  const left = [];

  for await (const page of scan("blog:" + only + ":dropbox:account")) {
    for (const key of await ofType(page, "hash")) {
      if (!ACCOUNT_KEY.test(key)) continue;
      result.accounts++;
      if (await leftAccount(key)) left.push(key);
    }
  }

  result.left = left.length;

  if (apply && left.length) {
    await pause(recheckMs);

    for (const key of left) {
      const found = await leftAccount(key);
      if (!found) continue;

      const multi = client.multi();
      multi.del(key);
      multi.del("blog:" + found.blogID + ":dropbox:access-token");
      if (found.accountID)
        multi.sRem("clients:dropbox:" + found.accountID, found.blogID);
      await multi.exec();
      result.deleted++;
    }
  }

  console.log(
    "dropbox-accounts: " +
      result.left +
      " of " +
      result.accounts +
      " Dropbox accounts belong to blogs on another client. " +
      verb(apply, "Deleted " + result.deleted, "Would delete them")
  );

  return result;
}

// ---- dropbox-legacy ----

const LEGACY_DROPBOX_SET = /^dropbox:[0-9]+$/;

async function dropboxLegacy({ apply = false, only = "*" } = {}) {
  const result = { found: 0, deleted: 0 };
  const sample = sampler();

  for await (const page of scan("dropbox:" + only)) {
    const keys = (await ofType(page, "set")).filter((key) =>
      LEGACY_DROPBOX_SET.test(key)
    );

    result.found += keys.length;
    for (const key of keys) await sample.add(key);

    if (apply && keys.length) result.deleted += await client.del(keys);
  }

  console.log(
    "dropbox-legacy: " +
      result.found +
      " sets of the old Dropbox client, about " +
      size(sample.estimate(result.found)) +
      ". " +
      verb(apply, "Deleted " + result.deleted, "Would delete them")
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

// The entry key a permalink's value names, or null when the key's name or
// value can't be read, which is never evidence that the entry is gone
function entryKeyFor(key, value) {
  const match = URL_KEY.exec(key);

  if (!match || typeof value !== "string" || !value) return null;

  try {
    return entryKey.entry(match[1], value);
  } catch (err) {
    return null;
  }
}

async function permalinks({
  apply = false,
  only = "*",
  wait = PERMALINK_WAIT_MS,
} = {}) {
  const result = { scanned: 0, stale: 0, deleted: 0, estimatedBytes: 0 };
  const sample = sampler();
  let pending = []; // [permalink key, value]

  // Entry.set writes the permalink key before the entry key, so a new
  // entry's key has no entry for a moment. So the keys which looked stale
  // are looked at again after a wait, and deleted only if each still holds
  // the value read and its entry is still missing.
  async function flush() {
    if (!pending.length) return;

    await pause(wait);

    for (let i = 0; i < pending.length; i += BATCH) {
      const chunk = pending.slice(i, i + BATCH);
      const multi = client.multi();

      for (const [key, value] of chunk) {
        multi.get(key);
        multi.exists(entryKeyFor(key, value));
      }

      const replies = await multi.exec();
      const del = client.multi();
      let count = 0;

      chunk.forEach(([key, value], j) => {
        if (replies[j * 2] !== value || replies[j * 2 + 1]) return;
        del.del(key);
        count++;
      });

      if (count) await del.exec();

      result.deleted += count;
    }

    pending = [];
  }

  for await (const page of scan("blog:" + only + ":url:*")) {
    const strings = await ofType(page, "string");
    if (!strings.length) continue;

    const values = await mget(strings);
    const readable = [];
    const keys = [];

    strings.forEach((key, i) => {
      const target = entryKeyFor(key, values[i]);

      // A name or value which doesn't parse is skipped, never stale
      if (!target) return;

      readable.push(i);
      keys.push(target);
    });

    if (!keys.length) continue;

    const multi = client.multi();
    for (const key of keys) multi.exists(key);
    const exists = await multi.exec();

    for (let j = 0; j < readable.length; j++) {
      result.scanned++;

      if (exists[j]) continue;

      result.stale++;
      await sample.add(strings[readable[j]]);

      if (apply) pending.push([strings[readable[j]], values[readable[j]]]);
    }

    if (pending.length >= PERMALINK_BATCH) await flush();
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

async function rendered({
  apply = false,
  only = "*",
  wait = RENDERED_WAIT_MS,
} = {}) {
  const result = { scanned: 0, unreferenced: 0, deleted: 0, estimatedBytes: 0 };
  const sample = sampler();
  let candidates = [];

  // Candidates first, then the references: an output written after the scan
  // is not a candidate, and one written before it is already referenced
  for await (const page of scan(RENDERED + only))
    candidates = candidates.concat(await ofType(page, "string"));

  result.scanned = candidates.length;

  const unreferenced = async (keys) => {
    const referenced = await referencedHashes();
    return keys.filter((key) => !referenced.has(key.slice(RENDERED.length)));
  };

  let stale = await unreferenced(candidates);

  result.unreferenced = stale.length;

  for (const key of stale.slice(0, SAMPLE)) await sample.add(key);

  if (apply && stale.length) {
    // Deleted only if still unreferenced when read again a minute later, so
    // a save which wrote an output and its manifest in between is kept
    await pause(wait);

    stale = await unreferenced(stale);

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

const SUBCOMMANDS = {
  "deleted-entries": deletedEntries,
  "deleted-blogs": deletedBlogs,
  "dropbox-members": dropboxMembers,
  "dropbox-accounts": dropboxAccounts,
  "dropbox-legacy": dropboxLegacy,
  "template-shares": templateShares,
  permalinks,
  rendered,
  ssl,
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
  dropboxAccounts,
  dropboxLegacy,
  templateShares,
  permalinks,
  rendered,
  ssl,
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
