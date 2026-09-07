const clfdate = require("helper/clfdate");

// node-redis deliberately exposes only lifecycle events, not its underlying
// socket. Keep this at that public boundary so diagnostic logging cannot alter
// connection behaviour or depend on node-redis internals.
module.exports = function instrumentRedis(name, client, endpoint) {
  const startedAt = Date.now();

  function context() {
    return {
      client: name,
      endpoint,
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      isOpen: client.isOpen,
      isReady: client.isReady,
    };
  }

  client.on("connect", () => {
    console.log(clfdate(), "Redis lifecycle connect", context());
  });

  client.on("ready", () => {
    console.log(clfdate(), "Redis lifecycle ready", context());
  });

  client.on("reconnecting", () => {
    console.warn(clfdate(), "Redis lifecycle reconnecting", context());
  });

  client.on("end", () => {
    console.warn(clfdate(), "Redis lifecycle end", context());
  });

  // An error listener is required by Node's EventEmitter contract. Log the
  // complete Error object so errno/code/syscall and its stack survive in the
  // container logs, rather than converting it to a lossy string.
  client.on("error", (error) => {
    console.error(clfdate(), "Redis lifecycle error", context(), error);
  });

  return client;
};
