var loadClient = require("./util/loadClient");
var database = require("./database");
var Blog = require("models/blog");
var debug = require("debug")("blot:clients:dropbox");
var Sync = require("sync");
var placeholders = require("clients/util/placeholders");

// Dont write tests for this or you'll need to regenerate
// an access token for Travis and it'll be annoying. Just
// test it on the development server.
module.exports = async function disconnect(blogID) {
  // Make sure we don't create something unexpected
  // by messing with a blog mid-sync. This might fail
  // we need to surface a clear error message to the user.
  await Sync(blogID, function (folder) {
    return remove(blogID, folder);
  });
};

async function remove(blogID, folder) {
  debug("getting account info");
  const { error, client, account } = await loadClient(blogID);

  // Invalid credentials might cause an error here
  // we still want to be able to disconnect
  if (error) debug("error createClient", error);

  folder.status("Disconnecting from Dropbox");

  // Their bytes are only in Dropbox, which Blot can no longer reach
  await placeholders.removeAtDisconnect(blogID, folder);

  debug("resetting client setting");
  await Blog.set(blogID, { client: "" });

  debug("dropping blog from database");

  folder.status("Removing Dropbox credentials");
  await database.drop(blogID);

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
