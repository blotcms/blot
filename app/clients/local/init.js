// This is invoked by the master process so if you make any
// changes to it you need to make sure the master process
// is restarted, not just the worker processes.
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
      setup(blogID).catch(function (err) {
        console.error(err);
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

  initialSetupTimer = setTimeout(async function () {
    let blogIDs;

    try {
      blogIDs = await Blog.getAllIDs();
    } catch (err) {
      console.error(err);
      return;
    }

    // One blog at a time. A failure stops the loop.
    try {
      for (const blogID of blogIDs) {
        console.log(prefix(), "Blog:", blogID, "Setting up");
        const blog = await Blog.get({ id: blogID });
        if (!blog || blog.client !== "local") continue;

        console.log(prefix(), "Synchronizing", blogID);
        await setup(blogID);
      }
    } catch (err) {
      console.error(prefix(), "Unable to check all blogs", err);
    }

    console.log(prefix(), "Checked all blogs");
  }, 5 * 1000); // 5s
};
