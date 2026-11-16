const s3 = require("storage/s3");
const { inUse, SCOPES } = require("./references");

const DAY = 24 * 60 * 60 * 1000;

// "<scope>/<id>" -> { files, bytes, newest } for each generated directory
async function stored(blogID) {
  const dirs = new Map();

  for (const scope of SCOPES) {
    const prefix = blogID + "/" + scope + "/";

    for await (const object of s3.listEntries(prefix)) {
      if (!object.key) continue;

      const id = object.key.slice(prefix.length).split("/")[0];

      if (!id) continue;

      const name = scope + "/" + id;
      const dir = dirs.get(name) || { files: 0, bytes: 0, newest: 0 };
      const modified = new Date(object.modified).getTime() || 0;

      dir.files++;
      dir.bytes += object.size || 0;
      dir.newest = Math.max(dir.newest, modified);
      dirs.set(name, dir);
    }
  }

  return dirs;
}

// A blog's totals: { scope: { stored, referenced, unreferenced, oldEnough } }
// in bytes, where oldEnough is the unreferenced bytes whose newest file is
// older than graceDays (what a deleting sweep would remove), and the
// unreferenced directories as a list when listUnreferenced.
async function report(blogID, options = {}) {
  const graceDays = options.graceDays || 60;
  const cutoff = Date.now() - graceDays * DAY;
  const used = await inUse(blogID);
  const dirs = await stored(blogID);
  const totals = {};
  const unreferenced = [];

  for (const scope of SCOPES)
    totals[scope] = { stored: 0, referenced: 0, unreferenced: 0, oldEnough: 0 };

  for (const [name, dir] of dirs) {
    const scope = name.split("/")[0];
    const t = totals[scope];

    t.stored += dir.bytes;

    if (used.has(name)) {
      t.referenced += dir.bytes;
    } else {
      t.unreferenced += dir.bytes;
      if (dir.newest < cutoff) t.oldEnough += dir.bytes;
      if (options.listUnreferenced) unreferenced.push(name);
    }
  }

  return { blogID, totals, unreferenced };
}

module.exports = { report, stored, DAY };
