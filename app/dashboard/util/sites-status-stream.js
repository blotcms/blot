// One stream of sync messages for every site the user owns, for the Sites
// list (js/sites-sync.js). Each message is JSON: { handle, message }. A page
// per site would need a stream per site, and browsers allow only a few open
// at once. Mounted at /sites/status ("status" is a banned site handle).
//
// Like helper/sse: a heartbeat keeps proxies from closing it, and it ends
// when this process starts to drain, so the browser reconnects elsewhere.

const redisSubscriber = require("helper/redisSubscriber");
const drain = require("helper/drain");
const { HEARTBEAT_INTERVAL_MS } = require("helper/sse");

module.exports = function (req, res) {
  const blogs = req.blogs || [];
  let closed = false;

  req.socket.setTimeout(2147483647);
  res.writeHead(200, {
    "X-Accel-Buffering": "no",
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  const write = (text) => {
    if (closed || res.destroyed || res.writableEnded) return;
    try {
      res.write(text);
    } catch (e) {}
  };

  const heartbeat = setInterval(
    () => write(": heartbeat\n\n"),
    HEARTBEAT_INTERVAL_MS
  );

  const subscriptions = blogs.map((blog) =>
    redisSubscriber({
      channel: "sync:status:" + blog.id,
      onMessage: (message) =>
        write(
          "data: " + JSON.stringify({ handle: blog.handle, message }) + "\n\n"
        ),
      onError: (err) => console.log("Redis Error: " + err),
    })
  );

  const offDrain = drain.onStart(() => {
    try {
      if (!res.writableEnded) res.end();
    } catch (e) {}
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    offDrain();
    clearInterval(heartbeat);
    subscriptions.forEach((subscription) => {
      Promise.resolve(subscription.cleanup()).catch((err) =>
        console.log("Redis Error: " + err)
      );
    });
  }

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);
};
