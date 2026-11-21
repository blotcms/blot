const client = require("models/client");

const PREFIX = require("./prefix");

// The Drive directories of a blog which have changed since its last sync, as
// a set of directory ids (#2847). syncChanges adds them, from changes.list
// and the search, and the next sync takes them and lists just those
// directories before its full walk. FULL asks for a full walk.
//
// take() removes what it returns in one SPOP, so an id added while a sync is
// running is left for the next one. A sync that fails puts what it took back.
// If a process dies holding some, the follow-up armed for the change runs a
// full walk, which covers them.
const FULL = "*";

// A set nobody takes (a blog disconnected meanwhile) goes away on its own
const TTL_SECONDS = 24 * 60 * 60;
// Taken at most this many at a time
const TAKE = 1000;

const key = (blogID) => `${PREFIX}dirty-dirs:${blogID}`;
const seenKey = (blogID) => `${PREFIX}dirty-seen:${blogID}`;
const movesKey = (blogID) => `${PREFIX}moved-folders:${blogID}`;

module.exports = {
  FULL,

  // source names what saw the directories change (changes, search,
  // walk:<trigger>), for the live line's stage timings (#2847). The first
  // sighting of each directory is kept until a sync takes it (seen below);
  // a putBack passes no source and keeps the sighting it had.
  async add(blogID, ids, source = null) {
    if (!ids.length) return;
    const multi = client
      .multi()
      .sAdd(key(blogID), ids)
      .expire(key(blogID), TTL_SECONDS);
    if (source) {
      const value = `${Date.now()} ${source}`;
      for (const id of ids) multi.hSetNX(seenKey(blogID), id, value);
      multi.expire(seenKey(blogID), TTL_SECONDS);
    }
    await multi.exec();
  },

  // When each directory was first seen to change, and by what, as
  // { id: { at, source } }, forgetting them so the next change is timed
  // afresh. Only for the log: a sighting lost to a race just goes unlogged.
  async seen(blogID, ids) {
    if (!ids.length) return {};
    const [values] = await client
      .multi()
      .hmGet(seenKey(blogID), ids)
      .hDel(seenKey(blogID), ids)
      .exec();
    const seen = {};
    ids.forEach((id, i) => {
      const [at, source] = String(values[i] || "").split(" ");
      if (Number(at) && source) seen[id] = { at: Number(at), source };
    });
    return seen;
  },

  async take(blogID) {
    // sPop would ignore a count: SPOP with one is sPopCount in node-redis
    return (await client.sPopCount(key(blogID), TAKE)) || [];
  },

  async count(blogID) {
    return await client.sCard(key(blogID));
  },

  // What is waiting, without taking it
  async members(blogID) {
    return await client.sMembers(key(blogID));
  },

  // Folders changes.list saw move (or be renamed), id -> the id of the
  // folder it is in now, so the sync that finds one missing from where it was
  // can move it there instead of removing it and downloading it all again
  // (#2847). Kept an hour.
  async hintMoves(blogID, moves) {
    if (!moves.length) return;
    const multi = client.multi();
    for (const { id, parentId } of moves)
      multi.hSet(movesKey(blogID), id, parentId);
    await multi.expire(movesKey(blogID), 60 * 60).exec();
  },

  async moveHint(blogID, id) {
    return await client.hGet(movesKey(blogID), id);
  },

  key,
  seenKey,
  movesKey,
};
