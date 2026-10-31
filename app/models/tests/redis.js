describe("models/redis", function () {
  const { ClientOfflineError } = require("redis");
  const EventEmitter = require("events");
  const createRedisClient = require("models/redis");

  // Nothing listens on port 1, so this client is never connected
  function unreachableClient() {
    const redis = require("redis");
    const client = redis.createClient({
      url: "redis://127.0.0.1:1",
      RESP: 3,
      socket: { reconnectStrategy: () => 200 },
    });
    client.on("error", function () {});
    client.connect().catch(function () {});
    return client;
  }

  it("leaves the offline queue alone until the client has connected", function () {
    const client = new EventEmitter();
    client.options = {};
    createRedisClient.failFastOnceReady(client);
    expect(client.options.disableOfflineQueue).toBeUndefined();
    client.emit("ready");
    expect(client.options.disableOfflineQueue).toBe(true);
  });

  it("stops queueing after a grace period if the client never connects", function () {
    jasmine.clock().install();
    try {
      const client = new EventEmitter();
      client.options = {};
      createRedisClient.failFastOnceReady(client);
      jasmine.clock().tick(createRedisClient.BOOT_QUEUE_MS - 1);
      expect(client.options.disableOfflineQueue).toBeUndefined();
      jasmine.clock().tick(1);
      expect(client.options.disableOfflineQueue).toBe(true);
    } finally {
      jasmine.clock().uninstall();
    }
  });

  it("commands hang without failFast while redis is unreachable", async function () {
    const client = unreachableClient();
    const outcome = await Promise.race([
      client.get("x").then(() => "settled", () => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    await client.destroy();
    expect(outcome).toBe("hung");
  });

  it("rejects commands already queued when failFast is switched on", async function () {
    const client = unreachableClient();
    const queued = client.get("x").then(
      () => "resolved",
      (e) => e
    );
    createRedisClient.failFast(client);
    const outcome = await Promise.race([
      queued,
      new Promise((resolve) => setTimeout(() => resolve("still queued"), 3000)),
    ]);
    await client.destroy();
    expect(outcome).not.toBe("still queued");
    expect(outcome).not.toBe("resolved");
  });

  it("commands reject immediately with failFast while redis is unreachable", async function () {
    const client = unreachableClient();
    createRedisClient.failFast(client);
    const started = Date.now();
    let error;
    try {
      await client.get("x");
    } catch (e) {
      error = e;
    }
    await client.destroy();
    expect(error instanceof ClientOfflineError).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("clients from createRedisClient fail fast once connected", async function () {
    const client = createRedisClient();
    expect(client.options.disableOfflineQueue).toBeFalsy();
    await client.connect();
    await client.ping();
    expect(client.options.disableOfflineQueue).toBe(true);
    await client.quit();
  });

  it("uses a socket timeout and ping interval to detect a stalled connection", function () {
    const client = createRedisClient();
    expect(client.options.pingInterval).toBe(createRedisClient.PING_INTERVAL_MS);
    expect(client.options.socket.socketTimeout).toBe(
      createRedisClient.SOCKET_TIMEOUT_MS
    );
    expect(typeof client.options.socket.reconnectStrategy).toBe("function");
    expect(createRedisClient.SOCKET_TIMEOUT_MS).toBeGreaterThan(
      createRedisClient.PING_INTERVAL_MS
    );
  });

  it("rejects commands when a connected server stops replying", async function () {
    const net = require("net");
    const redis = require("redis");
    let silent = false;

    // Answers everything with +OK until told to go quiet, without closing
    const server = net.createServer(function (socket) {
      socket.on("error", function () {});
      socket.on("data", function (data) {
        if (silent) return;
        const commands = (data.toString().match(/\*\d+\r\n/g) || []).length || 1;
        socket.write("+OK\r\n".repeat(commands));
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));

    const client = redis.createClient({
      url: "redis://127.0.0.1:" + server.address().port,
      RESP: 2,
      disableClientInfo: true,
      commandOptions: { timeout: undefined },
      pingInterval: 200,
      socket: {
        socketTimeout: 800,
        reconnectStrategy: createRedisClient.reconnectStrategy,
      },
    });
    client.on("error", function () {});
    await client.connect();
    createRedisClient.failFast(client);
    expect(await client.ping()).toBe("OK");

    silent = true;
    let error;
    try {
      await client.get("x");
    } catch (e) {
      error = e;
    }

    // The default strategy gives up after a socket timeout, leaving the client
    // closed for good. Ours must reconnect once the server replies again.
    silent = false;
    let recovered;
    for (let i = 0; i < 40 && recovered !== "OK"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        recovered = await client.ping();
      } catch (e) {}
    }

    await client.destroy();
    await new Promise((resolve) => server.close(resolve));

    expect(error && error.constructor.name).toBe("SocketTimeoutError");
    expect(recovered).toBe("OK");
  });

  describe("over a Unix socket", function () {
    const net = require("net");
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const config = require("config");
    const { isRedisUnavailableError } = require("helper/redisUnavailable");

    const socketPath = path.join(os.tmpdir(), "blot-redis-" + process.pid + ".sock");
    let original, server, connections;

    // The test Redis listens on TCP in another container, so this stands in
    // for the socket Redis serves in production: a Unix socket in this
    // process which pipes each connection through to it.
    beforeEach(async function () {
      original = config.redis.socket;
      connections = 0;
      fs.rmSync(socketPath, { force: true });
      server = net.createServer(function (client) {
        connections++;
        const redis = net.connect(config.redis.port, config.redis.host);
        client.on("error", function () {});
        redis.on("error", function () {});
        client.pipe(redis).pipe(client);
        client.on("close", () => redis.destroy());
      });
      await new Promise((resolve) => server.listen(socketPath, resolve));
    });

    afterEach(async function () {
      config.redis.socket = original;
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(socketPath, { force: true });
    });

    it("connects by path when config.redis.socket is set", async function () {
      config.redis.socket = socketPath;
      const client = createRedisClient();
      expect(client.options.url).toBeUndefined();
      expect(client.options.socket.path).toBe(socketPath);
      // The timeouts and reconnects which detect a stall apply as on TCP
      expect(client.options.socket.socketTimeout).toBe(
        createRedisClient.SOCKET_TIMEOUT_MS
      );
      expect(client.options.socket.reconnectStrategy).toBe(
        createRedisClient.reconnectStrategy
      );
      expect(client.options.pingInterval).toBe(createRedisClient.PING_INTERVAL_MS);

      const key = "test:redis-socket:" + Date.now();
      await client.connect();
      await client.set(key, "over the socket");
      expect(await client.get(key)).toBe("over the socket");
      await client.del(key);
      await client.quit();
      expect(connections).toBe(1);
    });

    it("gives library clients the socket too", async function () {
      config.redis.socket = socketPath;
      const client = createRedisClient.createLibraryClient("socket spec");
      expect(client.options.url).toBeUndefined();
      await client.ping();
      await client.quit();
      expect(connections).toBe(1);
    });

    it("fails visibly when the socket is missing, without falling back to TCP", async function () {
      // Redis is reachable over TCP at config.redis.host and port throughout
      config.redis.socket = socketPath + ".missing";
      const client = createRedisClient();
      const errors = [];
      client.on("error", (err) => errors.push(err));
      client.connect().catch(function () {});

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(client.isReady).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe("ENOENT");
      expect(errors[0].address).toBe(config.redis.socket);
      expect(isRedisUnavailableError(errors[0])).toBe(true);
      expect(connections).toBe(0);
      await client.destroy();
    });
  });
});
