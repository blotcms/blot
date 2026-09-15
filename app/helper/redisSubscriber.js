const createRedisClient = require("models/redis");

module.exports = function redisSubscriber({
  channel,
  onMessage,
  onError,
  logger = console,
}) {
  const client = createRedisClient();
  const messageHandler = typeof onMessage === "function" ? onMessage : function () {};
  let cleanedUp = false;
  let cleanupPromise;
  let disconnectPromise;

  function logRedisError(err) {
    try {
      if (typeof onError === "function") {
        onError(err);
        return;
      }

      logger.log("Redis Error:", err);
    } catch (e) {
      try {
        logger.log("Redis Error:", err);
      } catch (ignored) {}
    }
  }

  client.on("error", logRedisError);

  function disconnect() {
    if (disconnectPromise) return disconnectPromise;

    disconnectPromise = (async function () {
      try {
        try {
          if (client.isOpen) await client.unsubscribe(channel);
        } catch (err) {
          logRedisError(err);
        }

        try {
          if (client.isOpen) await client.quit();
        } catch (err) {
          logRedisError(err);
        }
      } finally {
        client.removeListener("error", logRedisError);
      }
    })();

    return disconnectPromise;
  }

  // Rejects on connect/subscribe failure. cleanup() waits on this promise
  // (not a catching wrapper) so a setup error cannot deadlock teardown.
  const setupPromise = Promise.resolve().then(async function () {
    await client.connect();
    if (cleanedUp) return;

    await client.subscribe(channel, function (message, subscribedChannel) {
      if (cleanedUp) return;
      try {
        messageHandler(message, subscribedChannel || channel);
      } catch (err) {
        logRedisError(err);
      }
    });
  });

  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanedUp = true;
    // Waiting for setup closes both race windows: a connect which finishes after
    // cleanup, and a subscribe already in flight when cleanup is requested.
    cleanupPromise = setupPromise.then(disconnect, disconnect);
    return cleanupPromise;
  }

  // Always tear the client down if setup fails, even if nobody called cleanup().
  setupPromise.catch(function (err) {
    logRedisError(err);
    return cleanup();
  });

  return {
    client,
    cleanup,
    setupPromise,
  };
};
