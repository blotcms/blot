var async = require("async");

module.exports = function registerGlobalTest() {
  global.test = {
    CheckEntry: require("./util/checkEntry"),
    SyncAndCheck: require("./util/syncAndCheck"),

    compareDir: require("./util/compareDir"),

    fake: require("./util/fake"),

    user: function () {
      beforeEach(function (done) {
        require("./util/createUser").call(this, function (err) {
          done(err);
        });
      });

      afterEach(function (done) {
        require("./util/removeUser").call(this, function (err) {
          done(err);
        });
      });
    },

    server: require("./util/server"),

    site: require("./util/site"),

    templates: require("./util/templates"),

    timeout: function (ms) {
      var originalTimeout;
      var hasOriginalTimeout = false;

      beforeAll(function () {
        if (
          !globalThis.jasmine ||
          typeof globalThis.jasmine.DEFAULT_TIMEOUT_INTERVAL !== "number"
        ) {
          throw new Error(
            "test.timeout(ms) requires jasmine.DEFAULT_TIMEOUT_INTERVAL to be available."
          );
        }

        originalTimeout = globalThis.jasmine.DEFAULT_TIMEOUT_INTERVAL;
        hasOriginalTimeout = true;
        globalThis.jasmine.DEFAULT_TIMEOUT_INTERVAL = ms;
      });

      afterAll(function () {
        if (hasOriginalTimeout && globalThis.jasmine) {
          globalThis.jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
        }
      });
    },

    blogs: function (total, options = {}) {
      var skipTeardown = options.skipTeardown === true;

      beforeEach(require("./util/createUser"));
      if (!skipTeardown) afterEach(require("./util/removeUser"));

      beforeEach(function (done) {
        var context = this;
        context.blogs = new Array(total);

        // Blog.create() reads the owning user's `blogs` array, appends the
        // new id, and writes it back (see app/models/blog/create.js). That
        // read-modify-write isn't safe against many concurrent writers on
        // the same user record: User.set()'s compare-and-swap (see
        // app/models/user/set.js) retries up to 20 times against a fresh
        // read of the user each time, but always reinserts the *same*
        // (increasingly stale) blogs array Blog.create computed once up
        // front, so heavy concurrency can exhaust those retries and throw
        // "User changed too frequently" - previously swallowed here (the
        // completion callback ignored its `err` and pushed `undefined`
        // anyway), which surfaced many calls later as a confusing
        // "Cannot read properties of undefined" once benchmark corpus runs
        // started creating hundreds of blogs per user. createBlog.js now
        // retries on that error with a fresh read, so contention just costs
        // a few retries rather than a crash - a concurrency cap of 10 fully
        // avoided the crash but was slow enough (with the corpus benchmark's
        // 1000 blogs) to blow the spec's own 20-minute timeout; 40 keeps
        // throughput up while createBlog.js's retries absorb the CAS
        // contention that shows up at this concurrency. Any failure that
        // does slip through still fails setup loudly instead of silently.
        async.timesLimit(
          total,
          40,
          function (index, next) {
            var result = { user: context.user };
            require("./util/createBlog").call(result, function (err) {
              if (err) return next(err);
              context.blogs[index] = result.blog;
              next();
            });
          },
          done
        );
      });

      if (!skipTeardown) {
        afterEach(function (done) {
          var context = this;
          async.each(
            this.blogs,
            function (blog, next) {
              require("./util/removeBlog").call(
                { user: context.user, blog: blog },
                next
              );
            },
            done
          );
        });
      }
    },

    blog: function (options = {}) {
      var skipTeardown = options.skipTeardown === true;

      beforeEach(require("./util/createUser"));
      if (!skipTeardown) afterEach(require("./util/removeUser"));

      beforeEach(require("./util/createBlog"));
      if (!skipTeardown) afterEach(require("./util/removeBlog"));
    },

    tmp: function () {
      beforeEach(require("./util/createTmpDir"));
      afterEach(require("./util/removeTmpDir"));
    },
  };
};
