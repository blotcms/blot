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

    blogs: function (total) {
      beforeEach(require("./util/createUser"));
      afterEach(require("./util/removeUser"));

      beforeEach(function (done) {
        var context = this;
        context.blogs = [];
        async.times(
          total,
          function (blog, next) {
            var result = { user: context.user };
            require("./util/createBlog").call(result, function () {
              context.blogs.push(result.blog);
              next();
            });
          },
          done
        );
      });

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
    },

    blog: function () {
      beforeEach(require("./util/createUser"));
      afterEach(require("./util/removeUser"));

      beforeEach(require("./util/createBlog"));
      afterEach(require("./util/removeBlog"));
    },

    tmp: function () {
      beforeEach(require("./util/createTmpDir"));
      afterEach(require("./util/removeTmpDir"));
    },
  };
};
