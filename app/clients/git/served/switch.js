// Whether a blog's repository is served from the git store (#2259, the
// cutover): config.git_store.serve, from BLOT_GIT_STORE_SERVE. Empty for off,
// "all", or a comma-separated list of blog IDs. Read on each call, like shadow
// mode's setting, so specs can change it.
//
// This is the only thing repo.js, sync.js and create.js load of the served
// path while it is off, so with it off nothing else here is required.
var config = require("config");

// Whether a setting ("", "all" or a list of IDs) names the blog
function names(setting, blogID) {
  setting = String(setting || "").trim();

  if (!setting) return false;
  if (setting === "all") return true;

  return (
    setting
      .split(",")
      .map(function (id) {
        return id.trim();
      })
      .indexOf(String(blogID)) !== -1
  );
}

function enabled(blogID) {
  return names(config.git_store && config.git_store.serve, blogID);
}

module.exports = { enabled: enabled, names: names };
