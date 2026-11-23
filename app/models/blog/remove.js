var client = require("models/client");
var config = require("config");
var folder = require("storage/folder");
var assets = require("storage/assets");
var get = require("./get");
var set = require("./set");
var key = require("./key");
var templateKey = require("models/template/key");
var BackupDomain = require("./util/backupDomain");
var flushCache = require("./flushCache");
var folderLock = require("sync/lock");
var purgeQueue = require("cdn/purgeQueue");
var dropTemplate = require("models/template/drop");

var START_CURSOR = "0";
var SCAN_SIZE = 1000;
var BLOG_ID_REGEX = /^blog_[a-f0-9]+$/;

function isValidBlogID(blogID) {
  return typeof blogID === "string" && BLOG_ID_REGEX.test(blogID);
}

// How long a removal has to finish before the scheduler resumes it
var RESUME_AFTER_MS = 10 * 60 * 1000;

// Resolves to the removed blog. Rejects with the error that stopped the
// removal: an invalid id, no such blog, or a failed step.
//
// A removal is a series of steps, and the process can be killed between any
// two (a deploy). The blog is recorded in key.removing before the first step
// and dropped after the last, and every step can be run again on a half
// removed blog, so scheduler/resume-blog-removal can finish what was
// interrupted by calling remove again.
var remove = async function remove(blogID) {
  if (!isValidBlogID(blogID)) throw new Error("Invalid blog id");

  var blog = await get({ id: blogID });

  if (!blog || !blog.id) {
    // The hash is deleted with the last step but one, so a blog that is
    // recorded as being removed and has no hash only needs its leftovers
    // cleaned up. Anything else was never a blog.
    if ((await client.zScore(key.removing, blogID)) === null)
      throw new Error("No blog");

    await finishWithoutRecord(blogID);
    await markRemoved(blogID);
    return { id: blogID };
  }

  // NX: a resumed removal keeps the time the scheduler set for it
  await client.zAdd(
    key.removing,
    { score: Date.now() + RESUME_AFTER_MS, value: blogID },
    { NX: true }
  );

  // Syncing needs the blog enabled, and so does disconnecting the client
  // (it takes the sync lock). A disabled blog is only enabled for that.
  if (blog.client && blog.isDisabled) {
    await set(blogID, { isDisabled: false });
    await flushCache(blogID);
  }

  // The order of these tasks is important right now.
  // For example, if you wipe the blog's folder before disconnecting
  // the client, you might run into an error. It would be nice to
  // be able to run them in parallel though
  await disconnectClient(blog);

  // The site stops serving from here, rather than being enabled until the
  // last step: a removal that is interrupted doesn't leave it public
  if (!blog.isDisabled || blog.client) {
    await set(blogID, { isDisabled: true });
    await flushCache(blogID);
  }

  await updateUser(blog);
  await dropFromDiscover(blog);
  await wipeFolders(blog);
  await dropTemplates(blog);
  await deleteKeys(blog);
  await purgeQueue.blog(blog.id);
  await markRemoved(blogID);

  return blog;
};

async function markRemoved(blogID) {
  var multi = client.multi();

  multi.zRem(key.removing, blogID);
  multi.hDel(key.removalAttempts, blogID);
  await multi.exec();
}

// What is left once the blog's hash is gone: its keys went with it (deleteKeys
// is one transaction), so it is the Discover posts, folder and generated
// files, and the CDN purge.
async function finishWithoutRecord(blogID) {
  await dropFromDiscover({ id: blogID });
  await wipeFolders({ id: blogID });
  await purgeQueue.blog(blogID);
}

// Required here, not at the top: models/discover requires models/blog
async function dropFromDiscover(blog) {
  await require("models/discover").removeBlog(blog.id);
}

async function wipeFolders(blog) {
  if (!blog.id || typeof blog.id !== "string")
    throw new Error("Invalid blog id");

  // removeAll only ever deletes the one folder named for the blog (blog IDs
  // must be a single path segment), never anything above or beside it
  await Promise.all([folder.removeAll(blog.id), assets.removeAll(blog.id)]);
}

// deleteKeys removes a template's keys but not its rendered CDN outputs
// (cdn:rendered:<hash>), which sit under no blog prefix, and queues no purge
// of its CDN urls. Template.drop does both. A template that fails to drop is
// logged and doesn't stop the removal.
async function dropTemplates(blog) {
  var templateIDs = await client.sMembers(templateKey.blogTemplates(blog.id));
  var prefix = blog.id + ":";

  for (var templateID of templateIDs) {
    try {
      if (templateID.indexOf(prefix) !== 0)
        throw new Error("Template is not owned by the blog");

      await dropTemplate.byID(blog.id, templateID);
    } catch (err) {
      console.error("Error dropping template", templateID, err);
    }
  }
}

async function deleteKeys(blog) {
  var multi = client.multi();
  var patterns = ["template:" + blog.id + ":*", "blog:" + blog.id + ":*"];

  var remove = [
    "template:owned_by:" + blog.id,
    templateKey.folderPendingRemoval(blog.id),
    templateKey.folderFresh(blog.id),
  ];

  if (blog.handle) {
    remove.push("handle:" + blog.handle);
    remove.push("domain:" + blog.handle + "." + config.host);
  }

  // TODO ALSO remove alternate key with/out 'www', e.g. www.example.com
  if (blog.domain) {
    remove.push("domain:" + blog.domain);
    remove.push("domain:" + BackupDomain(blog.domain));
  }

  for (const pattern of patterns) {
    var cursor = START_CURSOR;

    do {
      var res = await client.scan(cursor, {
        MATCH: pattern,
        COUNT: SCAN_SIZE,
      });

      if (!res || typeof res !== "object") {
        throw new Error("Unexpected SCAN reply: " + JSON.stringify(res));
      }

      cursor = String(res.cursor);

      if (Array.isArray(res.keys)) {
        remove = remove.concat(res.keys);
      }
    } while (cursor !== START_CURSOR);
  }

  // A sync (or a script under sync/hold) may still hold the folder
  // lock. Deleting it under them makes their release find it gone, and
  // a holder whose lock is lost crashes the process. The holder
  // releases it, or it expires on its own within the lock's TTL. So do
  // the keys a disconnect's seize (sync/seize.js) leaves: without them, a
  // holder it took the lock from would crash instead of stopping.
  var lockKeys = [
    folderLock.key(blog.id),
    folderLock.cancelKey(blog.id),
    folderLock.seizedKey(blog.id),
  ];
  remove = remove.filter(function (name) {
    return lockKeys.indexOf(name) === -1;
  });

  if (remove.length > 0) multi.del(remove);
  multi.sRem(key.ids, blog.id);
  await multi.exec();
}

async function disconnectClient(blog) {
  var clients = require("clients");

  if (!blog.client || !clients[blog.client]) return;

  try {
    await clients[blog.client].disconnect(blog.id);
  } catch (err) {
    // we still want to continue even if there is an error
    console.error("Error disconnecting client:", err);
  }
}

async function updateUser(blog) {
  var User = require("models/user");
  var user = await User.getById(blog.owner);

  // If the user has already been deleted then
  // we don't need to worry about this.
  if (!user || !user.blogs) return;

  var changes = {};

  var blogs = user.blogs.filter(function (otherBlogID) {
    return otherBlogID !== blog.id;
  });

  if (blogs.length !== user.blogs.length) changes.blogs = blogs;

  if (user.lastSession === blog.id) changes.lastSession = "";

  // A resumed removal finds the user already updated
  if (!Object.keys(changes).length) return;

  await User.set(blog.owner, changes);
}

module.exports = remove;
module.exports.RESUME_AFTER_MS = RESUME_AFTER_MS;
