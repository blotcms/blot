module.exports = function setup(options) {
  options = options || {};

  var dataDir = require("clients/git/dataDir");
  var disconnect = require("clients/git/disconnect");
  var fs = require("fs-extra");
  var Express = require("express");

  var setClientToGit = require("./setClientToGit");

  var server = {
    start: function attempt(done) {
      var port = 10000 + Math.round(Math.random() * 10000);
      this.server = Express()
        .use("/clients/git", require("clients/git/routes").site)
        .listen(port, function (err) {
          if (err && err.code === "EADDRINUSE") return attempt(done);
          if (err && err.code === "EACCESS") return attempt(done);
          if (err) return done(err);
          done();
        });
      this.server.port = port;
    },
    close: function (done) {
      this.server.close(done);
    },
  };

  // { once: true } does all of this once per describe (beforeAll/afterAll)
  // instead of for every spec, for specs that don't change the blog, the
  // repo or the server.
  var before = options.once ? beforeAll : beforeEach;
  var after = options.once ? afterAll : afterEach;

  global.test.blog({ once: options.once });

  // Sets up a temporary tmp folder and cleans it up after
  global.test.tmp({ once: options.once });

  // Increase individual spec timeout to 60 seconds
  global.test.timeout(60 * 1000); 

  // Set up a clean server for each test
  before(server.start);
  after(server.close);

  // Expose methods for creating fake files, paths, etc.
  before(function () {
    this.fake = global.test.fake;
  });

  // Clean a bare repo in app/clients/git/data if needed
  after(function (done) {
    // Each test creates a new bare repo in app/clients/git/data
    // Be careful cleaning this folder because it might contain
    // production data if the tests are accidentally run in prod.
    // In future it might be nice to pass a custom path to the
    // git client when initializing it? That way we could just
    // wipe the contents of this custom path at the end....
    fs.remove(dataDir + "/" + this.blog.handle + ".git", done);
  });

  after(function (done) {
    disconnect(this.blog.id, done);
  });

  if (options.setClientToGit !== false)
    before(function (done) {
      var context = this;

      setClientToGit(this.user, this.blog, this.server.port, function (
        err,
        repoUrl
      ) {
        if (err) return done(err);

        context.repoUrl = repoUrl;
        done();
      });
    });

  // { client: true } makes a clone with a real git client (./client.js)
  // as this.local, instead of the simple-git clone below. Pass
  // { clone: false } with it. Specs written with it never touch the bare
  // repository or the blog folder's .git directory.
  if (options.client)
    before(async function () {
      this.local = await require("./client").forContext(this);
    });

  if (options.clone !== false)
    before(function (done) {
      var context = this;

      require("simple-git")(this.tmp)
        .silent(true)
        .clone(this.repoUrl, function (err) {
          if (err) return done(new Error(err));
          context.repoDirectory = context.tmp + "/" + context.blog.handle;
          context.git = require("simple-git")(context.repoDirectory).silent(
            true
          );
          context.gitBare = require("simple-git")(
            dataDir + "/" + context.blog.handle + ".git"
          ).silent(true);
          context.gitBlot = require("simple-git")(context.blogDirectory).silent(
            true
          );
          done(null);
        });
    });
};
