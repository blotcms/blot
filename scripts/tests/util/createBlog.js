var Blog = require("models/blog");
var randomString = require("./randomString");
var localPath = require("helper/localPath");
const fs = require("fs-extra");
const { join } = require("path");
const { promisify } = require("util");
const rebuild = promisify(require("sync/rebuild"));
const checkEntry = require("./checkEntry");

// Blog.create() reads the owning user's `blogs` array, appends the new id,
// and writes it back with User.set() - a plain read-modify-write, not a
// retry-safe append. User.set()'s own compare-and-swap (see
// app/models/user/set.js) only guards against the *value* changing under
// it; every one of its internal retries still reinserts the same
// (increasingly stale) blogs array Blog.create computed once up front, so
// when many blogs are created concurrently under one user - as the corpus
// benchmark does (up to 1000) - that CAS can exhaust its 20 attempts and
// throw "User changed too frequently" (err.code "EAGAIN"). Retrying the
// whole create here, which re-reads the user's current blogs from scratch,
// clears that contention without having to throttle concurrency so low
// that building a 1000-site corpus blows the spec's own timeout.
var MAX_ATTEMPTS = 8;

module.exports = function (done) {
  var context = this;

  attempt(context, 0, done);
};

function attempt(context, attemptIndex, done) {
  Blog.create(context.user.uid, { handle: randomString(16) }, function (
    err,
    blog
  ) {
    if (err) {
      if (err.code === "EAGAIN" && attemptIndex < MAX_ATTEMPTS - 1) {
        return attempt(context, attemptIndex + 1, done);
      }

      // validate() (see app/models/blog/validate.js) fails with a plain
      // {field: message} errors object rather than an Error instance; any
      // other failure (e.g. Blog.create's User.set() call) is already a
      // proper Error and should be passed through as-is so its real message
      // (and stack) survives instead of being replaced with a blank
      // "Error: undefined".
      return done(err instanceof Error ? err : new Error(err.handle));
    }

    context.blogDirectory = localPath(blog.id, "/");

    if (context.blogDirectory.slice(-1) === "/")
      context.blogDirectory = context.blogDirectory.slice(0, -1);

    context.blog = blog;

    context.blog.update = async (updates) => {
      await promisify(Blog.set)(context.blog.id, updates);
    };

    context.blog.write = async ({ path, content }) => {
      await fs.outputFile(join(context.blogDirectory, path), content);
    };

    context.blog.remove = async (path) => {
      await fs.remove(join(context.blogDirectory, path));
    };
    
    context.blog.rebuild = async (options = {}) =>
      await rebuild(context.blog.id, options);

    context.blog.check = async (entry) =>
      await promisify(checkEntry(context.blog.id))(entry);

    if (context.write === undefined) context.write = context.blog.write;

    if (context.remove === undefined) context.remove = context.blog.remove;

    if (context.publish === undefined) context.publish = async ({ path, content }) => {
      await context.blog.write({ path, content });
      await context.blog.rebuild();
    };
    
    done(err);
  });
};
