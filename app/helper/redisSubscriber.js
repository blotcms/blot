const createRedisClient = require("models/redis");
const { ClientOfflineError } = require("redis");

// Every subscription in the process shares one connection. Redis lets a
// connection subscribe to any number of channels and node-redis resubscribes
// them all after a reconnect. A connection per subscriber meant every open SSE
// stream held its own connection, and during an outage each one ran its own
// reconnect loop which outlived the stream.
let shared;

function getShared() {
  // A client which has been closed never comes back, so start again
  if (shared && shared.client.isOpen) return shared;

  const client = createRedisClient();
  const state = {
    client,
    // channel -> entry, see subscribe() below
    channels: new Map(),
    // dispatch function -> channel, for unsubscribes lost to a disconnect
    stale: new Map(),
  };

  // Before its first connection the client queues commands for up to
  // BOOT_QUEUE_MS (see models/redis), so subscribers wait that long too
  state.firstReady = new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(new ClientOfflineError());
    }, createRedisClient.BOOT_QUEUE_MS);
    if (typeof timer.unref === "function") timer.unref();

    client.once("ready", function () {
      clearTimeout(timer);
      resolve();
    });
  });
  state.firstReady.catch(function () {});

  client.on("ready", function () {
    const stale = Array.from(state.stale);
    state.stale.clear();
    stale.forEach(function ([dispatch, channel]) {
      unsubscribe(state, channel, dispatch);
    });
  });

  // node-redis retries forever with our reconnect strategy, so this only
  // rejects if the client is closed while connecting. Errors on the way are
  // logged by the listener models/redis attaches.
  client.connect().catch(function (err) {
    console.log("Redis Error: subscriber connect failed:", err);
  });

  shared = state;
  return state;
}

// Once the client has connected, or spent its grace period failing to,
// models/redis switches off its offline queue: Redis is down, so reject now
// rather than hold the caller open until it comes back.
function whenReady(state) {
  if (state.client.isReady) return Promise.resolve();
  if (state.client.options && state.client.options.disableOfflineQueue) {
    return Promise.reject(new ClientOfflineError());
  }
  return state.firstReady;
}

// One Redis subscription per channel, fanned out to every local listener.
// Each entry has its own dispatch function because node-redis tracks
// listeners by identity: the UNSUBSCRIBE for an entry which is going away
// must not remove a newer entry for the same channel.
function subscribe(state, channel) {
  const entry = { listeners: new Set() };

  entry.dispatch = function (message, subscribedChannel) {
    Array.from(entry.listeners).forEach(function (listener) {
      listener(message, subscribedChannel || channel);
    });
  };

  // Resolves true once subscribed, false if every listener left first
  entry.subscribed = whenReady(state).then(function () {
    if (state.channels.get(channel) !== entry) return false;
    return state.client.subscribe(channel, entry.dispatch).then(function () {
      return true;
    });
  });

  // Let the next subscriber to this channel try again
  entry.subscribed.catch(function () {
    if (state.channels.get(channel) === entry) state.channels.delete(channel);
  });

  return entry;
}

function unsubscribe(state, channel, dispatch) {
  // Not awaited: while Redis is down node-redis holds the command until it
  // reconnects, and tearing down a subscriber should not wait on that.
  state.client.unsubscribe(channel, dispatch).catch(function () {
    // The connection dropped before Redis replied, so node-redis still holds
    // the channel and resubscribes it on reconnect. Try again then.
    state.stale.set(dispatch, channel);
  });
}

function release(state, channel, entry, listener) {
  entry.listeners.delete(listener);
  if (entry.listeners.size || state.channels.get(channel) !== entry) return;

  state.channels.delete(channel);

  // Wait for a SUBSCRIBE in flight so the UNSUBSCRIBE follows it
  entry.subscribed.then(
    function (subscribed) {
      if (subscribed) unsubscribe(state, channel, entry.dispatch);
    },
    function () {}
  );
}

module.exports = function redisSubscriber({
  channel,
  onMessage,
  onError,
  logger = console,
}) {
  const state = getShared();
  const messageHandler = typeof onMessage === "function" ? onMessage : function () {};
  let cleanedUp = false;
  let cleanupPromise;

  // Only errors for this subscription come here. Connection errors are
  // logged once by models/redis, not once per subscriber.
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

  function listener(message, subscribedChannel) {
    if (cleanedUp) return;
    try {
      messageHandler(message, subscribedChannel);
    } catch (err) {
      logRedisError(err);
    }
  }

  let entry = state.channels.get(channel);
  if (!entry) {
    entry = subscribe(state, channel);
    state.channels.set(channel, entry);
  }
  entry.listeners.add(listener);

  // The channel may have been subscribed before Redis went down, so check the
  // connection for every subscriber, not only the first on a channel
  const setupPromise = Promise.all([whenReady(state), entry.subscribed]).then(
    function () {}
  );

  // Never waits on Redis, so callers can always finish tearing down
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanedUp = true;
    release(state, channel, entry, listener);
    cleanupPromise = Promise.resolve();
    return cleanupPromise;
  }

  // Always release the listener if setup fails, even if nobody calls cleanup()
  setupPromise.catch(function (err) {
    logRedisError(err);
    return cleanup();
  });

  return {
    client: state.client,
    cleanup,
    setupPromise,
  };
};
