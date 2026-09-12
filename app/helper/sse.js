const redisSubscriber = require("helper/redisSubscriber");

// Some upstream proxies (e.g. the preview subdomain's nginx config) have a
// read timeout well under a minute and will close an idle connection before
// the browser's EventSource notices. Send a periodic comment line to keep
// the connection alive so we don't miss a message published during the
// (otherwise recurring) reconnect gap.
const HEARTBEAT_INTERVAL_MS = 10 * 1000;

module.exports = function ({ channel }) {
  return function (req, res) {
    req.socket.setTimeout(2147483647);

    res.writeHead(200, {
      // This header tells NGINX to NOT
      // buffer the response. Otherwise
      // the messages don't make it to the client.
      // A similar problem to the one caused
      // by the compression middleware a few lines down.
      "X-Accel-Buffering": "no",
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    res.write("\n");

    const heartbeat = setInterval(function () {
      try {
        res.write(": heartbeat\n\n");
      } catch (e) {}
    }, HEARTBEAT_INTERVAL_MS);

    const subscription = redisSubscriber({
      channel: channel(req),
      onMessage: function (message) {
        res.write("\n");
        res.write("data: " + message + "\n\n");
        res.flushHeaders();
      },
      onError: function (err) {
        console.log("Redis Error: " + err);
      },
    });

    req.on("close", function () {
      clearInterval(heartbeat);
      subscription.cleanup();
    });
  };
};
