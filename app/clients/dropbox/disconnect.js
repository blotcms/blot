var loadClient = require("./util/loadClient");
var database = require("./database");
var Blog = require("models/blog");
var debug = require("debug")("blot:clients:dropbox");
var seize = require("sync/seize");
var placeholders = require("clients/util/placeholders");
var hashes = require("./util/hashes");

// Dont write tests for this or you'll need to regenerate
// an access token for Travis and it'll be annoying. Just
// test it on the development server.
//
// The account is dropped under the blog's folder lock, taken from any sync
// or setup still running (sync/seize.js): that sync is stopped, its requests
// to Dropbox are cut off, and it writes nothing to the account or the folder
// afterwards.
module.exports = async function disconnect(blogID) {
  await seize(blogID, ({ signal }) => remove(blogID, signal), {
    reason: "disconnect",
  });

  // Their bytes are only in Dropbox, which Blot can no longer reach. Once
  // seize has released the lock: removeAtDisconnect syncs each removal, so
  // it takes the lock itself. The account is gone by now, so no webhook
  // sync can bring a placeholder back meanwhile.
  await placeholders.removeAtDisconnect(blogID);
};

async function remove(blogID, signal) {
  debug("getting account info");
  const { error, client, account } = await loadClient(blogID, { signal });

  // Invalid credentials might cause an error here
  // we still want to be able to disconnect
  if (error) debug("error createClient", error);

  debug("resetting client setting");
  await Blog.set(blogID, { client: "" });

  debug("dropping blog from database");
  await database.drop(blogID);
  // Only a cache: a failure must not stop the disconnect
  await hashes.drop(blogID).catch((err) => debug("dropping hashes", err));

  if (!account) {
    debug("the user chose Dropbox but did not connect their account");
    return;
  }

  if (!client) {
    debug("the user does not have a valid dropbox account");
    return;
  }

  debug("listing blogs with this account", account.account_id);
  const blogs = await database.listBlogs(account.account_id);

  // check if this is the last blog using this oauth token
  // then revoke it as needed.
  if (blogs.length) return;

  try {
    await client.authTokenRevoke();
    debug("token revoked successfully");
  } catch (err) {
    // you get an error revoking a revoked token
    debug("token failed to revoke", err);
  }
}
