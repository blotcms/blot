var Blog = require("models/blog");
var database = require("./database");

// Clears blog.client and forgets the stored tokens. Microsoft has no
// app-side call to revoke a refresh token, so the user removes Blot's
// access from their Microsoft account settings if they want it revoked.
// Once folder sync exists (PLAN.md) this also needs to take the folder
// lock and delete the Graph change-notification subscription.
module.exports = function disconnect(blogID, callback) {
  Blog.set(blogID, { client: "" }, function (err) {
    if (err) return callback(err);

    database.drop(blogID, function (err) {
      callback(err || null);
    });
  });
};
