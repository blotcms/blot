// The one thing repo.js loads of shadow mode. It reads the setting, and only
// when shadow mode is on for the blog does it load the rest (./index.js, and
// with it the git store and the S3 client), so with it off no store code runs
// and nothing is required that could fail.
//
//   shadow(blogID, function (mirror) { mirror.pushed(blogID, ms); });
//
// Nothing here throws into the push or the write that called it.
var config = require("config");
var clfdate = require("helper/clfdate");

// BLOT_GIT_STORE_SHADOW: empty for off, "all", or a comma-separated list of
// blog IDs. Read on each call, so specs can change it.
function enabled(blogID) {
  var setting = String((config.git_store && config.git_store.shadow) || "").trim();

  if (!setting) return false;
  if (setting === "all") return true;

  return setting
    .split(",")
    .map(function (id) {
      return id.trim();
    })
    .indexOf(String(blogID)) !== -1;
}

function shadow(blogID, fn) {
  if (!enabled(blogID)) return;

  try {
    fn(require("./index"));
  } catch (err) {
    console.error(clfdate(), "[git-store-shadow] blog=" + blogID, "could not start:", err.message);
  }
}

// The blog's git client is being disconnected, or the blog deleted: stops
// any shadow work for it in this process and deletes its copy in the store
// (<blogID>/git/ in the storage bucket), whether or not shadow mode is on now,
// since it may have been before. With no bucket configured, and no shadow
// work ever started in this process, there is nothing to do. Always calls
// back without an error: a failure is logged, and the disconnect goes on.
function remove(blogID, callback) {
  var hasBucket = !!(config.storage && config.storage.bucket);
  var loaded = !!require.cache[require.resolve("./index")];

  if (!hasBucket && !loaded) return process.nextTick(callback);

  var mirror;

  try {
    mirror = require("./index");
  } catch (err) {
    console.error(clfdate(), "[git-store-shadow] blog=" + blogID, "could not remove the store copy:", err.message);
    return process.nextTick(callback);
  }

  mirror.removeBlog(blogID).then(
    function () {
      callback();
    },
    function () {
      callback();
    }
  );
}

module.exports = shadow;
module.exports.enabled = enabled;
module.exports.remove = remove;
