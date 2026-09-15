const { getEntry } = require("../lib/models");
const attachAdjacent = require("../lib/attachAdjacent");
const drafts = require("sync/update/drafts");
const redisSubscriber = require("helper/redisSubscriber");

// (node:73631) TimeoutOverflowWarning: 1.7976931348623157e+308 does not fit into a 32-bit signed integer.
// Timer duration was truncated to 2147483647.
const MAX_TIMEOUT = 2147483647;

// Preview vhosts use reverse-proxy-preview.conf (proxy_read_timeout 15s).
// Live blog hosts send /draft/stream/ through reverse-proxy-sse.conf (24h),
// but a draft opened on a preview-* host still needs this keepalive.
const HEARTBEAT_INTERVAL_MS = 10 * 1000;

function endResponse(res) {
  try {
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch (e) {}
}

async function renderDraft(req, res, next, filePath, callback) {
  const blog = req.blog;
  const blogID = blog.id;

  const entry = await getEntry(blogID, filePath);
  if (!entry || !entry.draft || entry.deleted) {
    // The stream route has already sent SSE headers; don't hand a 404
    // to Express error middleware on a live event-stream.
    if (res.headersSent) {
      endResponse(res);
      return;
    }
    return next();
  }

  await attachAdjacent(blogID, entry);
  res.locals.entry = entry;

  await new Promise(function (resolve) {
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      resolve();
    }

    function renderNext(err) {
      if (res.headersSent) {
        endResponse(res);
      } else {
        next(err);
      }
      settle();
    }

    try {
      res.renderView("entry.html", renderNext, function (_err, output) {
        try {
          drafts.injectScript(output, filePath, function (html, bodyHTML) {
            try {
              callback(html, bodyHTML);
            } finally {
              settle();
            }
          });
        } catch (err) {
          renderNext(err);
        }
      });
    } catch (err) {
      renderNext(err);
    }
  });
}

function createRenderQueue({ render, isClosed }) {
  let rendering = false;
  let renderPending = false;

  async function drain() {
    if (rendering || isClosed()) return;
    rendering = true;
    try {
      do {
        renderPending = false;
        if (isClosed()) break;
        await render();
      } while (renderPending && !isClosed());
    } catch (err) {
      // Keep draining if a render failed after a later notify().
    } finally {
      rendering = false;
      if (renderPending && !isClosed()) void drain();
    }
  }

  return {
    notify: function () {
      if (isClosed()) return;
      renderPending = true;
      void drain();
    },
    clear: function () {
      renderPending = false;
    },
  };
}

module.exports = function register(blog) {
  blog.get(drafts.streamRoute, async function (req, res, next) {
    const blogID = req.blog.id;
    const filePath = drafts.getPath(req.url, drafts.streamRoute);
    let closed = false;

    req.socket.setTimeout(MAX_TIMEOUT);

    res.writeHead(200, {
      // This header tells NGINX to NOT
      // buffer the response. Otherwise
      // the messages don't make it to the client.
      // A similar problem to the one caused
      // by the compression middleware a few lines down.
      "X-Accel-Buffering": "no",
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    res.write("\n");

    const channel = "blog:" + blogID + ":draft:" + filePath;

    function responseIsClosed() {
      return closed || res.destroyed || res.writableEnded;
    }

    const heartbeat = setInterval(function () {
      if (responseIsClosed()) return;
      try {
        res.write(": heartbeat\n\n");
      } catch (e) {}
    }, HEARTBEAT_INTERVAL_MS);

    const renderQueue = createRenderQueue({
      isClosed: responseIsClosed,
      render: async function () {
        if (responseIsClosed()) return;
        await renderDraft(req, res, next, filePath, function (_html, bodyHTML) {
          if (responseIsClosed()) return;
          try {
            res.write("\n");
            res.write("data: " + JSON.stringify(bodyHTML.trim()) + "\n\n");
            res.flushHeaders();
          } catch (e) {}
        });
      },
    });

    const subscription = redisSubscriber({
      channel,
      onMessage: function () {
        renderQueue.notify();
      },
      onError: function (err) {
        console.log("Redis Error: " + err);
      },
    });

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      renderQueue.clear();
      req.removeListener("close", cleanup);
      req.removeListener("aborted", cleanup);
      res.removeListener("close", cleanup);
      void Promise.resolve(subscription.cleanup()).catch(function (err) {
        console.log("Redis Error: " + err);
      });
    }

    void subscription.setupPromise.catch(function () {
      cleanup();
      endResponse(res);
    });

    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("close", cleanup);
  });

  blog.get(drafts.viewRoute, async function (req, res, next) {
    const filePath = drafts.getPath(req.url, drafts.viewRoute);

    // Asks search engines not to index drafts
    res.set("X-Robots-Tag", "noindex");
    res.set("Cache-Control", "no-cache");

    try {
      await renderDraft(req, res, next, filePath, function (html) {
        // Remove the frame protection headers added by the server
        // middleware. They prevent Firefox from rendering the iframe
        // used in the preview file.
        res.removeHeader("X-Frame-Options");
        res.removeHeader("Content-Security-Policy");

        // bodyHTML is passed after HTML
        res.send(html);
      });
    } catch (err) {
      return next(err);
    }
  });
};

module.exports.createRenderQueue = createRenderQueue;
module.exports.HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_MS;
