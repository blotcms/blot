// Shared set-up for the git client's specs: a test blog on the git client
// with its repository set up in the git store (a memory object store per blog,
// or whatever the spec passes, and the store's cache in the spec's tmp
// folder), a test server for the git routes, and a clone.
//
//   require("./setup")(options)
//
//   once            do all of this once per describe (beforeAll/afterAll)
//                   instead of for every spec, for specs that don't change
//                   the blog, the repo or the server
//   setClientToGit  false: no repository is set up (the spec does it)
//   client          true: a clone with a real git client (./client.js) as
//                   this.local; pass { clone: false } with it
//   clone           false: no clone with ./git as this.git
//   objectStore     function (blogID) returning the blog's object store,
//                   called with the spec's this
//   lines           true: console.log is spied on, and this.storeLines(op)
//                   is the [git-store-served] lines logged (for an op)
//
// In a spec: this.stores[blogID] is the blog's memory store.
module.exports = function setup(options) {
  options = options || {};

  var config = require("config");
  var disconnect = require("clients/git/disconnect");
  var context = require("clients/git/served/context");
  var upkeep = require("clients/git/served/upkeep");
  var removal = require("clients/git/served/remove");
  var { createMemoryStore } = require("clients/git/store");
  var Express = require("express");
  var fs = require("fs-extra");
  var path = require("path");
  var tempDir = require("helper/tempDir");

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

  var before = options.once ? beforeAll : beforeEach;
  var after = options.once ? afterAll : afterEach;

  global.test.blog({ once: options.once });

  // Sets up a temporary tmp folder and cleans it up after
  global.test.tmp({ once: options.once });

  // Increase individual spec timeout to 60 seconds
  global.test.timeout(60 * 1000);

  var saved;

  // The store: a memory object store per blog, the cache in tmp, no log file
  before(function () {
    var ctx = this;

    // Not in this.tmp, which specs list
    ctx.storeScratch = fs.mkdtempSync(path.join(tempDir(), "git-store-spec-"));

    saved = Object.assign({}, config.git_store);
    config.git_store.cache_directory = ctx.storeScratch + "/cache";
    config.git_store.cache_bytes = 256 * 1024 * 1024;
    // A runner's disk may well be fuller than production's floor
    config.git_store.min_free_percent = 0;

    ctx.stores = {};
    context._setObjectStore(
      options.objectStore
        ? options.objectStore.bind(ctx)
        : function (blogID) {
            return (ctx.stores[blogID] = ctx.stores[blogID] || createMemoryStore());
          }
    );

    // With { lines: true }, what the store logs is kept, for storeLines
    ctx.lines = [];
    if (options.lines) {
      var log = console.log;
      spyOn(console, "log").and.callFake(function () {
        var line = Array.prototype.join.call(arguments, " ");
        if (line.indexOf("[git-store-served]") !== -1) ctx.lines.push(line);
        log.apply(console, arguments);
      });
    }

    ctx.storeLines = function (op) {
      return ctx.lines.filter(function (line) {
        return !op || line.indexOf(" op=" + op + " ") !== -1;
      });
    };
  });

  // Declared first, so it runs last: nothing from a spec is still running
  // when the next starts
  after(async function () {
    await upkeep.idle(this.blog.id);
    removal._reset();
    context._setObjectStore(null);
    await context._close();
    Object.assign(config.git_store, saved);
    await fs.remove(this.storeScratch);
  });

  // Set up a clean server for each test
  before(server.start);
  after(server.close);

  // Expose methods for creating fake files, paths, etc.
  before(function () {
    this.fake = global.test.fake;
  });

  after(function (done) {
    disconnect(this.blog.id, done);
  });

  if (options.setClientToGit !== false)
    before(function (done) {
      var context = this;

      setClientToGit(this.user, this.blog, this.server.port, function (err, repoUrl) {
        if (err) return done(err);

        context.repoUrl = repoUrl;
        done();
      });
    });

  // { client: true } makes a clone with a real git client (./client.js)
  // as this.local, instead of the clone below made with ./git. Pass
  // { clone: false } with it.
  if (options.client)
    before(async function () {
      this.local = await require("./client").forContext(this);
    });

  if (options.clone !== false)
    before(function (done) {
      var context = this;

      require("./git")(this.tmp)
        .silent(true)
        .clone(this.repoUrl, function (err) {
          if (err) return done(new Error(err));
          context.repoDirectory = context.tmp + "/" + context.blog.handle;
          context.git = require("./git")(context.repoDirectory).silent(true);
          done(null);
        });
    });
};
