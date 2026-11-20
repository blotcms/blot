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

module.exports = {
  FULL,

  async add(blogID, ids) {
    if (!ids.length) return;
    await client
      .multi()
      .sAdd(key(blogID), ids)
      .expire(key(blogID), TTL_SECONDS)
      .exec();
  },

  async take(blogID) {
    const ids = await client.sPop(key(blogID), TAKE);
    if (Array.isArray(ids)) return ids;
    return ids ? [ids] : [];
  },

  async count(blogID) {
    return await client.sCard(key(blogID));
  },

  key,
};
