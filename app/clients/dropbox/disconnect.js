var createClient = require("./util/createClient");
var database = require("./database");
var Blog = require("models/blog");
var debug = require("debug")("blot:clients:dropbox");
var Sync = require("sync");

// Dont write tests for this or you'll need to regenerate
// an access token for Travis and it'll be annoying. Just
// test it on the development server.
module.exports = function disconnect(blogID, callback) {
  // Make sure we don't create something unexpected
  // by messing with a blog mid-sync. This might fail
  // we need to surface a clear error message to the user.
  Sync(blogID, function (err, folder, done) {
    if (err) return callback(err);

    debug("getting account info");
    createClient(blogID, async function (err, client, account) {
      // Invalid credentials might cause an error here
      // we still want to be able to disconnect
      if (err) debug("error createClient", err);

      folder.status("Disconnecting from Dropbox");


      debug("resetting client setting");
      Blog.set(blogID, { client: "" }, function (err) {
        if (err) return done(err, callback);

        debug("dropping blog from database");

        folder.status("Removing Dropbox credentials");
        database.drop(blogID, function (err) {
          if (err) return done(err, callback);

          if (!account) {
            debug("the user chose Dropbox but did not connect their account");
            return done(null, callback);
          }

          if (!client) {
            debug("the user does not have a valid dropbox account");
            return done(null, callback);
          }

          debug("listing blogs with this account", account.account_id);
          database.listBlogs(account.account_id, function (err, blogs) {
            if (err) return done(err, callback);

            // check if this is the last blog using this oauth token
            // then revoke it as needed.
            if (blogs.length) {
              return done(null, callback);
            }

            client
              .authTokenRevoke()
              .then(function () {
                debug("token revoked successfully");
                done(null, callback);
              })
              .catch(function (err) {
                // you get an error revoking a revoked token
                debug("token failed to revoke", err);
                done(null, callback);
              });
          });
        });
      });
    });
  });
};
