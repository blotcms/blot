var promisify = require("util").promisify;
var client = require("models/client");
var Blog = require("models/blog");
var key = require("./key");
var getMetadata = promisify(require("./getMetadata"));
var setMetadata = promisify(require("./setMetadata"));
var drop = promisify(require("./drop"));

var getBlog = promisify(Blog.get);
var setBlog = promisify(Blog.set);

// Carries a locally-edited template over to the template that was just built
// from its renamed folder: settings which live in Redis rather than in the
// folder's files are copied across, the blog is switched over if the old
// template was installed, and then the old template is dropped.
module.exports = async function renameLocalTemplate(blogID, fromID, toID) {
  var from = await getMetadata(fromID);
  var to = await getMetadata(toID);
  var blog = await getBlog({ id: blogID });

  var changes = { localEditing: true };

  ["description", "thumb", "previewPath", "cloneFrom"].forEach(function (field) {
    if (from[field] !== undefined) changes[field] = from[field];
  });

  changes.locals = Object.assign({}, from.locals, to.locals);

  // Switch first so the site never points at a template that's gone
  if (blog.template === fromID) await setBlog(blogID, { template: toID });

  // The new template may already have been shared; its link is replaced by
  // the old template's, so don't leave it pointing here
  if (to.shareID && to.shareID !== from.shareID) {
    await client.del(key.share(to.shareID));
    changes.shareID = "";
  }

  await setMetadata(toID, changes);

  // Dropping removes the share link, so we re-point it afterwards
  var shareID = from.shareID;

  await drop(blogID, fromID.split(":").slice(1).join(":"));

  if (shareID) {
    await setMetadata(toID, { shareID: shareID });
    await client.set(key.share(shareID), toID);
  }
};
