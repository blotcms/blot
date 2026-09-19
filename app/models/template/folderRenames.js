// A local template is identified by its folder name, so renaming the folder
// of the *installed* template looks like it disappearing and another template
// appearing, leaving the blog pointing at a template that no longer exists.
// Depending on the client the two halves can arrive in the same sync or in
// separate ones, so we persist just enough between syncs to pair them up:
//
//   pending: the installed template whose folder went missing, with the time
//            we noticed and its views. It's kept (not dropped) for
//            RENAME_WINDOW, during which the site keeps working.
//   fresh:   templates first created from a folder, with the time we saw them.
//
// Templates which aren't installed are simply dropped and re-created: nothing
// depends on them and everything they contain is in the folder.

var crypto = require("crypto");
var client = require("models/client");
var getAllViews = require("./getAllViews");
var key = require("./key");

var RENAME_WINDOW = 2 * 60 * 1000; // 2 minutes
var MIN_SIMILARITY = 0.5;

// Fresh records only matter within the window, but a pending record has to
// survive until the next sync after the window, which on a quiet site could be
// weeks away (clients sync when files change, not on a timer). If it expired
// first, the still-missing template would look like a new orphan and its
// window would start over. RENAME_WINDOW is enforced by the timestamps.
var FRESH_TTL = Math.ceil((RENAME_WINDOW * 2) / 1000);
var PENDING_TTL = 60 * 60 * 24 * 90; // 90 days

function pendingKey(blogID) {
  return key.folderPendingRemoval(blogID);
}

function freshKey(blogID) {
  return key.folderFresh(blogID);
}

// Maps each view name to a hash of its content
function viewHashes(templateID) {
  return new Promise(function (resolve, reject) {
    getAllViews(templateID, function (err, views) {
      if (err) return reject(err);

      var hashes = {};

      Object.keys(views || {}).forEach(function (name) {
        hashes[name] = crypto
          .createHash("sha1")
          .update(views[name].content || "")
          .digest("hex");
      });

      resolve(hashes);
    });
  });
}

// How alike two templates are, from 0 to 1. A view with the same name and
// content counts fully, one with the same name but edited content counts half,
// out of every view name in either template. A renamed folder whose files were
// also edited still scores high, while an unrelated theme that merely shares
// common view names (entries.html, style.css...) scores low.
function similarity(a, b) {
  var names = Object.keys(a);
  var union = new Set(names.concat(Object.keys(b)));

  if (!union.size) return 0;

  var score = 0;

  names.forEach(function (name) {
    if (!Object.prototype.hasOwnProperty.call(b, name)) return;
    score += a[name] === b[name] ? 1 : 0.5;
  });

  return score / union.size;
}

async function readAll(hashKey) {
  var raw = (await client.hGetAll(hashKey)) || {};
  var result = {};

  Object.keys(raw).forEach(function (field) {
    try {
      result[field] = JSON.parse(raw[field]);
    } catch (e) {
      // ignore unreadable records, they'll be overwritten or pruned
    }
  });

  return result;
}

module.exports = {
  RENAME_WINDOW: RENAME_WINDOW,
  MIN_SIMILARITY: MIN_SIMILARITY,
  pendingKey: pendingKey,
  freshKey: freshKey,
  viewHashes: viewHashes,
  similarity: similarity,

  markFresh: async function (blogID, templateID) {
    await client.hSet(freshKey(blogID), templateID, JSON.stringify(Date.now()));
    await client.expire(freshKey(blogID), FRESH_TTL);
  },

  readFresh: function (blogID) {
    return readAll(freshKey(blogID));
  },

  readPending: function (blogID) {
    return readAll(pendingKey(blogID));
  },

  setPending: async function (blogID, templateID, record) {
    await client.hSet(pendingKey(blogID), templateID, JSON.stringify(record));
    await client.expire(pendingKey(blogID), PENDING_TTL);
  },

  clear: async function (blogID, templateID) {
    await client.hDel(pendingKey(blogID), templateID);
    await client.hDel(freshKey(blogID), templateID);
  },
};
