const client = require("models/client");

const PREFIX = require("./prefix");

// The Drive directories of each service account's blogs that changed in the
// last few minutes, for serviceAccount/pollRecentFolders.js to list again and
// again (#2847). A sorted set per service account, of "<blogID> <dirId>"
// scored by when the directory was last seen to change. Every change source
// touches the directories it records (syncChanges.js for changes.list and the
// search, sync/index.js for the walk), and the poller touches what it finds
// changed itself, including new folders inside, so a folder being written to
// stays listed while it is.
const WINDOW_MS = 5 * 60 * 1000;

const key = (serviceAccountId) => `${PREFIX}recent-dirs:${serviceAccountId}`;

const memberOf = (blogID, dirId) => `${blogID} ${dirId}`;

module.exports = {
  WINDOW_MS,

  async touch(serviceAccountId, blogID, dirIds, now = Date.now()) {
    const ids = dirIds.filter((id) => id && !id.includes(" ") && id !== "*");
    if (!serviceAccountId || !blogID || !ids.length) return;
    await client
      .multi()
      .zAdd(
        key(serviceAccountId),
        ids.map((id) => ({ score: now, value: memberOf(blogID, id) }))
      )
      .pExpire(key(serviceAccountId), WINDOW_MS)
      .exec();
  },

  // The most recently changed directories, at most limit, as
  // [{ blogID, dirId, at }], forgetting those older than the window
  async list(serviceAccountId, limit, now = Date.now()) {
    const [, members] = await client
      .multi()
      .zRemRangeByScore(key(serviceAccountId), "-inf", now - WINDOW_MS)
      .zRangeWithScores(key(serviceAccountId), 0, limit - 1, { REV: true })
      .exec();
    return (members || []).map(({ value, score }) => {
      const [blogID, dirId] = value.split(" ");
      return { blogID, dirId, at: Number(score) };
    });
  },

  key,
};
