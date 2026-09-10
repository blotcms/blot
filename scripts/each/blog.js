var User = require("models/user");
var Blog = require("models/blog");
var async = require("async");
var type = require("helper/type");
var ensure = require("helper/ensure");
var progress = require("./progress");

module.exports = function (doThis, allDone, options) {
  options = options || {};

  ensure(doThis, "function").and(allDone, "function").and(options, "object");

  Blog.getAllIDs(function (err, blogIDs) {
    if (err || !blogIDs) throw err || "No";

    if (options.r) {
      console.log("Reversing the order of the blogs...");
      blogIDs = blogIDs.reverse();
    }

    if (options.s) {
      options.s = parseInt(options.s);
      console.log("Starting this script with blog which has ID", options.s);
      blogIDs = blogIDs.slice(options.s - 1);
    }

    if (options.e) {
      var end = parseInt(options.e);
      var start = 0;

      if (options.s) {
        start = parseInt(options.s);
        end = end - start + 1;
        if (end < 1) end = undefined;
      }

      if (end) {
        console.log("Ending this script at user with ID", options.e);
        blogIDs = blogIDs.slice(0, end);
      } else {
        console.log("Warning: The end option was less than the start...");
      }
    }

    if (options.o) {
      if (type(options.o, "array")) {
        blogIDs = options.o.map(function (id) {
          return id + "";
        });
      } else {
        blogIDs = [options.o + ""];
      }

      console.log(
        "Starting this for blogs with ID",
        blogIDs.length > 1 ? blogIDs : blogIDs[0]
      );
    }

    var forEach = async.eachSeries;

    if (options.p) {
      forEach = async.each;
    } else if (options.c && parseInt(options.c, 10) > 1) {
      // Bounded concurrency: overlap the per-blog Redis reads without the
      // unbounded fan-out of options.p. The nested progress line (Blog x
      // Template x View) assumes one blog in flight at a time, so with
      // options.c it only tracks the blog frame reliably - acceptable for a
      // one-off migration where throughput matters more than a tidy status
      // line.
      var limit = parseInt(options.c, 10);
      forEach = function (items, iterator, cb) {
        async.eachLimit(items, limit, iterator, cb);
      };
    }

    var bar = progress.push("Blog", blogIDs.length);

    forEach(
      blogIDs,
      function (blogID, done) {
        var nextBlog = function (err) {
          bar.tick();
          done(err);
        };

        Blog.get({ id: blogID }, function (err, blog) {
          if (err || !blog) {
            return nextBlog();
          }

          User.getById(blog.owner, function (err, user) {
            if (err) throw err;

            if (!user) {
              // console.error(new Error("No user with uid " + blog.owner));
              return nextBlog();
            }

            doThis(user, blog, nextBlog);
          });
        });
      },
      function (err) {
        bar.pop();
        allDone(err);
      }
    );
  });
};
