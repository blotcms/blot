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
var promiseOnly = require("helper/promiseOnly");

var START_CURSOR = "0";
var SCAN_SIZE = 1000;
var BLOG_ID_REGEX = /^blog_[a-f0-9]+$/;

function isValidBlogID(blogID) {
  return typeof blogID === "string" && BLOG_ID_REGEX.test(blogID);
}

// Resolves to the removed blog. Rejects with the error that stopped the
// removal: an invalid id, no such blog, or a failed step.
var remove = promiseOnly(async function remove(blogID) {
  if (!isValidBlogID(blogID)) throw new Error("Invalid blog id");

  var blog = await get({ id: blogID });
  if (!blog || !blog.id) throw new Error("No blog");

  // We need to enable the blog to disconnect the client
  // since we need to acquire a sync lock...
  await set(blogID, { isDisabled: false });

  await flushCache(blogID);

  // The order of these tasks is important right now.
  // For example, if you wipe the blog's folder before disconnecting
  // the client, you might run into an error. It would be nice to
  // be able to run them in parallel though
  await disconnectClient(blog);
  await updateUser(blog);
  await wipeFolders(blog);
  await deleteKeys(blog);

  return blog;
});

async function wipeFolders(blog) {
  if (!blog.id || typeof blog.id !== "string")
    throw new Error("Invalid blog id");

  // removeAll only ever deletes the one folder named for the blog (blog IDs
  // must be a single path segment), never anything above or beside it
  await Promise.all([folder.removeAll(blog.id), assets.removeAll(blog.id)]);
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
  // releases it, or it expires on its own within the lock's TTL.
  var folderLockKey = folderLock.key(blog.id);
  remove = remove.filter(function (name) {
    return name !== folderLockKey;
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

  var blogs = user.blogs.slice();

  blogs = blogs.filter(function (otherBlogID) {
    return otherBlogID !== blog.id;
  });

  changes.blogs = blogs;

  if (user.lastSession === blog.id) changes.lastSession = "";

  await User.set(blog.owner, changes);
}

module.exports = remove;
