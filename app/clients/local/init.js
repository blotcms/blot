// This is invoked by the master process so if you make any
// changes to it you need to make sure the master process
// is restarted, not just the worker processes.
const async = require("async");
const debug = require("debug")("blot:clients:local:setup");
const setup = require("./setup");
const redisSubscriber = require("helper/redisSubscriber");
const clfdate = require("helper/clfdate");
const Blog = require("models/blog");
const prefix = () => clfdate() + " Local folder client:";

module.exports = async () => {
  // This communication channel allows us to load in and out
  // new blogs in external scripts. We send a message to this
  // channel in scripts/load/info.js
  var CHANNEL = "clients:local:new-folder";
  console.log(prefix(), "Listening");

  const subscription = redisSubscriber({
    channel: CHANNEL,
    onMessage: function (message, channel) {
      debug("recieved", message, "on", channel);
      if (channel !== CHANNEL) return;
      let { blogID } = JSON.parse(message);
      setup(blogID, function (err) {
        if (err) console.error(err);
      });
    },
    onError: function (err) {
      console.error(err);
    },
  });

  let initialSetupTimer;

  const cleanup = function () {
    if (initialSetupTimer) clearTimeout(initialSetupTimer);
    void Promise.resolve(subscription.cleanup()).catch(function (err) {
      console.error(err);
    });
  };

  process.once("SIGTERM", cleanup);
  process.once("SIGINT", cleanup);
  process.once("exit", cleanup);

  await subscription.setupPromise;

  initialSetupTimer = setTimeout(function () {
    Blog.getAllIDs(function (err, blogIDs) {
      if (err) console.error(err);
      async.eachSeries(
        blogIDs,
        function (blogID, next) {
          console.log(prefix(), "Blog:", blogID, "Setting up");
          Blog.get({ id: blogID }, function (err, blog) {
            if (err) return next(err);
            if (!blog || blog.client !== "local") return next();

            console.log(prefix(), "Synchronizing", blogID);
            setup(blogID, function (err) {
              if (err) return next(err);
              next();
            });
          });
        },
        function (err) {
          console.log(prefix(), "Checked all blogs");
        }
      );
    });
  }, 5 * 1000); // 5s
};
