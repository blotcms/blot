var url = require("url");

// As the dashboard does: the blog is set to the git client, then its
// repository is set up from its folder. Calls back with the clone URL.
module.exports = function setClientToGit(user, blog, port, callback) {
  var repoUrl;

  require("models/blog").set(blog.id, { client: "git" }, function (err) {
    if (err) return callback(err);

    blog.client = "git";

    require("clients/git/create")(blog)
      .then(function () {
        return require("clients/git/database").getToken(blog.owner);
      })
      .then(function (token) {
        repoUrl = url.format({
          auth: user.email + ":" + token,
          protocol: "http",
          hostname: "127.0.0.1",
          port: port,
          pathname: "/clients/git/end/" + blog.handle + ".git",
        });

        callback(null, repoUrl);
      }, callback);
  });
};
