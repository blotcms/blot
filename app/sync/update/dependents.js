const client = require("models/client");
const Blog = require("models/blog");
const Entry = require("models/entry");
const {
  rebuildDependent,
  markTemplateDependents,
} = require("./rebuildDependents");

// What depends on a changed file is rebuilt once, when the sync ends, not
// once per file (#2978). A batch of images used by one post rebuilds the post
// once, from the dependency graph as it stands then: an entry deleted in the
// sync is gone from it, and a renamed one is there under its new path.
//
// Two Redis sets record the work, so a sync killed before the end (a
// deploy) leaves it for the next sync of the blog:
//
//   blog:<id>:sync:dependents_pending  the paths whose dependents need a
//                                      rebuild (set.js adds a path before
//                                      Entry.set, so a kill between the two
//                                      is caught too)
//   blog:<id>:sync:dependents_targets  "<path>\0<target>": where to look for
//                                      a pending path's dependents: the path,
//                                      a folder post's entry path, and the
//                                      wikilink keys of its entry
//
// A path is removed from both once its dependents have been rebuilt. One
// pending with no targets (left by code from before the targets set) is
// looked up as itself.

const SEPARATOR = "\0";

function pendingKey(blogID) {
  return "blog:" + blogID + ":sync:dependents_pending";
}

function targetsKey(blogID) {
  return "blog:" + blogID + ":sync:dependents_targets";
}

// A sync's memory of what it did, for the rebuild at its end. Each event (a
// path's change starting, an entry saved) takes the next number, so the
// rebuild can tell an entry saved after every change it depends on, which
// read the new files already and needs no rebuild.
function tracker() {
  let counter = 0;

  return {
    // Paths this sync recorded as needing their dependents rebuilt
    needed: new Set(),
    // The number of each path's latest change, taken when set() marks it
    // pending, before its own entry is saved: an entry of the path's (a
    // folder post's aggregate, for one of its files) saved after that read
    // it. A path record() sees unmarked (a public file, a drop) takes one then
    startedAt: new Map(),
    recordedAt: new Map(),
    // The number of each entry's latest save, by the entry's own path, as
    // dependents sets list it
    savedAt: new Map(),
    next: () => ++counter,
  };
}

function pairs(path, targets) {
  return targets.map((target) => path + SEPARATOR + target);
}

// Adds path to dependents_pending and targets to dependents_targets, before
// the entry is saved, so a sync killed or failing after the save still has
// them rebuilt. Resolves to whether an earlier sync, or an earlier set() of
// this sync that failed before record(), left the path pending.
async function markPending(blogID, path, targets, track) {
  const [added] = await client
    .multi()
    .sAdd(pendingKey(blogID), path)
    .sAdd(targetsKey(blogID), pairs(path, targets))
    .exec();

  if (track) track.startedAt.set(path, track.next());

  if (Number(added) === 1) return false;
  return !(track && track.needed.has(path));
}

// Adds more targets for a pending path (the wikilink keys of its new entry)
async function addTargets(blogID, path, targets) {
  if (targets.length)
    await client.sAdd(targetsKey(blogID), pairs(path, targets));
}

// For a path whose entry came out unchanged: removes it and its targets from
// the sets, unless this sync already recorded it as needing its dependents
// rebuilt
async function clearPending(blogID, path, targets, track) {
  if (track && track.needed.has(path)) return;

  await client
    .multi()
    .sRem(pendingKey(blogID), path)
    .sRem(targetsKey(blogID), pairs(path, targets))
    .exec();
}

// Records that the dependents of targets need rebuilding because path
// changed, and marks the templates which link to them for a CDN manifest
// update (cheap, and already done once per sync). Rebuilt by drain().
async function record(blogID, path, targets, track) {
  await client
    .multi()
    .sAdd(pendingKey(blogID), path)
    .sAdd(targetsKey(blogID), pairs(path, targets))
    .exec();

  if (track) {
    track.needed.add(path);
    track.recordedAt.set(
      path,
      track.startedAt.has(path) ? track.startedAt.get(path) : track.next()
    );
    track.startedAt.delete(path);
  }

  for (const target of targets) {
    await markTemplateDependents(blogID, target);
  }
}

// After Entry.set of a sync's build has resolved
function saved(track, entryPath) {
  if (track) track.savedAt.set(entryPath, track.next());
}

// Rebuilds, once each, what depends on the pending paths. Resolves to the
// number of entries rebuilt. Stops early, leaving the rest pending, once
// signal aborts. track is the sync's tracker(), or none for leftovers only.
async function drain(blogID, { track, signal, status, log } = {}) {
  const pending = await client.sMembers(pendingKey(blogID));

  if (!pending.length) return 0;

  const targetsOf = new Map();

  for (const member of await client.sMembers(targetsKey(blogID))) {
    const i = member.indexOf(SEPARATOR);
    if (i === -1) continue;
    const path = member.slice(0, i);
    if (!targetsOf.has(path)) targetsOf.set(path, []);
    targetsOf.get(path).push(member);
  }

  // Each dependent with the pending paths it depends on, in the order found
  const sourcesOf = new Map();
  // Each pending path with how many of its dependents are still to rebuild
  const remaining = new Map();

  for (const path of pending) {
    const members = targetsOf.get(path) || [];
    const targets = members.length
      ? members.map((member) => member.slice(path.length + 1))
      : [path];
    const dependents = new Set();

    for (const target of targets) {
      for (const dependent of await client.sMembers(
        Entry.key.dependents(blogID, target)
      )) {
        dependents.add(dependent);
      }
    }

    remaining.set(path, dependents.size);

    for (const dependent of dependents) {
      if (!sourcesOf.has(dependent)) sourcesOf.set(dependent, []);
      sourcesOf.get(dependent).push(path);
    }
  }

  const finish = async (path) => {
    const members = targetsOf.get(path) || [];
    const multi = client.multi();
    multi.sRem(pendingKey(blogID), path);
    if (members.length) multi.sRem(targetsKey(blogID), members);
    await multi.exec();
  };

  for (const [path, count] of remaining) {
    if (count === 0) await finish(path);
  }

  if (!sourcesOf.size) return 0;

  const blog = await Blog.get({ id: blogID });

  if (!blog) throw new Error("No blog");

  const total = sourcesOf.size;
  let done = 0;
  let rebuilt = 0;

  for (const [dependent, sources] of sourcesOf) {
    if (signal && signal.aborted) break;

    if (!upToDate(track, dependent, sources)) {
      await rebuildDependent(blog, dependent, log);
      rebuilt++;
    }

    done++;
    if (status && (done === 1 || done % 10 === 0 || done === total))
      status("Rebuilding entries " + done + "/" + total);

    for (const path of sources) {
      const left = remaining.get(path) - 1;
      remaining.set(path, left);
      if (left === 0) await finish(path);
    }
  }

  return rebuilt;
}

// Whether the dependent was saved in this sync after each of its pending
// paths was recorded in this sync: it built from the new files already. A
// path left pending by an earlier sync always needs the rebuild.
function upToDate(track, dependent, sources) {
  if (!track) return false;

  const savedAt = track.savedAt.get(dependent);

  if (savedAt === undefined) return false;

  return sources.every((path) => {
    const recordedAt = track.recordedAt.get(path);
    return recordedAt !== undefined && recordedAt < savedAt;
  });
}

module.exports = {
  pendingKey,
  targetsKey,
  tracker,
  markPending,
  addTargets,
  clearPending,
  record,
  saved,
  drain,
};
