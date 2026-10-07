describe("redisUnavailable", function () {
  const Express = require("express");
  const fetch = require("node-fetch");
  const config = require("config");
  const {
    ClientOfflineError,
    ClientClosedError,
    ConnectionTimeoutError,
    SocketClosedUnexpectedlyError,
  } = require("redis");
  const {
    isRedisUnavailableError,
    redisUnavailableHandler,
  } = require("helper/redisUnavailable");

  describe("isRedisUnavailableError", function () {
    it("recognises node-redis connectivity errors", function () {
      expect(isRedisUnavailableError(new ClientOfflineError())).toBe(true);
      expect(isRedisUnavailableError(new ClientClosedError())).toBe(true);
      expect(isRedisUnavailableError(new ConnectionTimeoutError())).toBe(true);
      expect(isRedisUnavailableError(new SocketClosedUnexpectedlyError())).toBe(true);
    });

    it("recognises socket errors aimed at the redis server", function () {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      err.port = config.redis.port;
      expect(isRedisUnavailableError(err)).toBe(true);
    });

    it("recognises a refused connection by address and port", function () {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      err.address = config.redis.host;
      err.port = config.redis.port;
      expect(isRedisUnavailableError(err)).toBe(true);
    });

    it("matches on port alone when the redis host is a DNS name", function () {
      const original = config.redis.host;
      config.redis.host = "redis";
      try {
        const err = new Error("connect ECONNREFUSED");
        err.code = "ECONNREFUSED";
        err.address = "172.18.0.2";
        err.port = config.redis.port;
        expect(isRedisUnavailableError(err)).toBe(true);
      } finally {
        config.redis.host = original;
      }
    });

    it("ignores lookup failures for other hostnames, even with a DNS redis host", function () {
      const original = config.redis.host;
      config.redis.host = "redis";
      try {
        const err = new Error("getaddrinfo ENOTFOUND api.stripe.com");
        err.code = "ENOTFOUND";
        err.hostname = "api.stripe.com";
        expect(isRedisUnavailableError(err)).toBe(false);

        err.hostname = "redis";
        expect(isRedisUnavailableError(err)).toBe(true);
      } finally {
        config.redis.host = original;
      }
    });

    it("ignores the redis host on another port", function () {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      err.address = config.redis.host;
      err.port = Number(config.redis.port) + 1;
      expect(isRedisUnavailableError(err)).toBe(false);
    });

    it("ignores socket errors that do not say where they were headed", function () {
      const err = new Error("read ECONNRESET");
      err.code = "ECONNRESET";
      expect(isRedisUnavailableError(err)).toBe(false);
    });

    it("ignores socket errors aimed at other servers", function () {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      err.port = 1;
      expect(isRedisUnavailableError(err)).toBe(false);
    });

    it("recognises error replies by class, as node-redis raises them", function () {
      // node-redis raises SimpleError (or BlobError), never a bare ErrorReply
      const { SimpleError, BlobError } = require("redis");
      const messages = [
        "LOADING Redis is loading the dataset in memory",
        "MASTERDOWN Link with MASTER is down and replica-serve-stale-data is set to 'no'.",
        "READONLY You can't write against a read only replica.",
        "NOREPLICAS Not enough good replicas to write.",
        "OOM command not allowed when used memory > 'maxmemory'.",
        "MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk.",
        "EXECABORT Transaction discarded because of previous errors.",
      ];
      messages.forEach(function (message) {
        expect(isRedisUnavailableError(new SimpleError(message))).toBe(true);
        expect(isRedisUnavailableError(new BlobError(message))).toBe(true);
      });
    });

    it("ignores other error replies", function () {
      const { SimpleError } = require("redis");
      expect(
        isRedisUnavailableError(
          new SimpleError("WRONGTYPE Operation against a key")
        )
      ).toBe(false);
      expect(
        isRedisUnavailableError(new SimpleError("ERR unknown command 'FOO'"))
      ).toBe(false);
    });

    it("looks inside the replies of a failed MULTI", function () {
      const { SimpleError, MultiErrorReply } = require("redis");
      expect(
        isRedisUnavailableError(
          new MultiErrorReply(
            ["OK", new SimpleError("OOM command not allowed")],
            [1]
          )
        )
      ).toBe(true);
      expect(
        isRedisUnavailableError(
          new MultiErrorReply(["OK", new SimpleError("WRONGTYPE nope")], [1])
        )
      ).toBe(false);
    });

    it("finds the error inside a wrapper", function () {
      const err = new Error("wrapped", { cause: new ClientOfflineError() });
      expect(isRedisUnavailableError(err)).toBe(true);
    });

    it("ignores unrelated errors", function () {
      expect(isRedisUnavailableError(new Error("nope"))).toBe(false);
      expect(isRedisUnavailableError(null)).toBe(false);
      expect(isRedisUnavailableError("ClientOfflineError")).toBe(false);
    });
  });

  // Puts a real Redis into each state and checks that what node-redis raises
  // is recognised. Building error objects by hand is what hid the original bug
  // (the classifier compared the class name, which is never what node-redis
  // uses). Specs run one at a time against a Redis of their own, and every
  // state is undone afterwards.
  describe("against a redis that rejects writes", function () {
    const redis = require("redis");
    const createRedisClient = require("models/redis");
    let admin, client, original;

    // Runs the callback and resolves to the error it rejects with
    async function rejection(fn) {
      try {
        await fn();
      } catch (err) {
        return err;
      }
      throw new Error("Expected the command to be rejected");
    }

    async function redisConfig(name) {
      const reply = await admin.configGet(name);
      return reply[name];
    }

    beforeEach(async function () {
      admin = redis.createClient({
        url: `redis://${config.redis.host}:${config.redis.port}`,
      });
      admin.on("error", function () {});
      await admin.connect();
      client = createRedisClient();
      client.on("error", function () {});
      await client.connect();
      original = {
        minReplicas: await redisConfig("min-replicas-to-write"),
        maxmemory: await redisConfig("maxmemory"),
        policy: await redisConfig("maxmemory-policy"),
        serveStale: await redisConfig("replica-serve-stale-data"),
      };
    });

    afterEach(async function () {
      await admin.sendCommand(["REPLICAOF", "NO", "ONE"]);
      await admin.configSet("min-replicas-to-write", original.minReplicas);
      await admin.configSet("maxmemory", original.maxmemory);
      await admin.configSet("maxmemory-policy", original.policy);
      await admin.configSet("replica-serve-stale-data", original.serveStale);
      await client.destroy();
      await admin.destroy();
    });

    it("recognises NOREPLICAS, the write freeze used during a cutover", async function () {
      await admin.configSet("min-replicas-to-write", "1");

      const err = await rejection(() => client.set("redis-unavailable:a", "1"));
      expect(err.message).toMatch(/^NOREPLICAS/);
      expect(isRedisUnavailableError(err)).toBe(true);

      const multiErr = await rejection(() =>
        client.multi().set("redis-unavailable:a", "1").exec()
      );
      expect(isRedisUnavailableError(multiErr)).toBe(true);
    });

    it("recognises OOM, when maxmemory is reached with noeviction", async function () {
      await admin.configSet("maxmemory-policy", "noeviction");
      await admin.configSet("maxmemory", "1");

      const err = await rejection(() => client.set("redis-unavailable:a", "1"));
      expect(err.message).toMatch(/^OOM/);
      expect(isRedisUnavailableError(err)).toBe(true);
    });

    it("recognises EXECABORT, when a command queued in a transaction was rejected", async function () {
      await admin.configSet("maxmemory-policy", "noeviction");
      await client.sendCommand(["MULTI"]);
      await admin.configSet("maxmemory", "1");

      const queued = await rejection(() =>
        client.sendCommand(["SET", "redis-unavailable:a", "1"])
      );
      expect(isRedisUnavailableError(queued)).toBe(true);

      const err = await rejection(() => client.sendCommand(["EXEC"]));
      expect(err.message).toMatch(/^EXECABORT/);
      expect(isRedisUnavailableError(err)).toBe(true);
    });

    // The master is unreachable, so nothing is synced and no data is lost
    it("recognises READONLY, when the host has become a replica", async function () {
      await admin.sendCommand(["REPLICAOF", "127.0.0.1", "1"]);

      const err = await rejection(() => client.set("redis-unavailable:a", "1"));
      expect(err.message).toMatch(/^READONLY/);
      expect(isRedisUnavailableError(err)).toBe(true);
    });

    it("recognises MASTERDOWN, when a replica that won't serve stale data has lost its master", async function () {
      await admin.configSet("replica-serve-stale-data", "no");
      await admin.sendCommand(["REPLICAOF", "127.0.0.1", "1"]);

      const err = await rejection(() => client.get("redis-unavailable:a"));
      expect(err.message).toMatch(/^MASTERDOWN/);
      expect(isRedisUnavailableError(err)).toBe(true);
    });

    it("does not mistake an ordinary command error for an outage", async function () {
      await client.set("redis-unavailable:string", "1");

      const err = await rejection(() => client.lPush("redis-unavailable:string", "x"));
      expect(err.message).toMatch(/^WRONGTYPE/);
      expect(isRedisUnavailableError(err)).toBe(false);

      await client.del("redis-unavailable:string");
    });
  });

  describe("redisUnavailableHandler", function () {
    let server, origin;

    beforeEach(function (done) {
      const app = Express();
      app.get("/redis", (req, res, next) => next(new ClientOfflineError()));
      app.get("/other", (req, res, next) => {
        const err = new Error("boom");
        err.status = 418;
        next(err);
      });
      app.use(redisUnavailableHandler);
      app.use((err, req, res, next) => res.status(err.status).send("passed on"));
      server = app.listen(0, () => {
        origin = "http://127.0.0.1:" + server.address().port;
        done();
      });
    });

    afterEach(function (done) {
      server.close(done);
    });

    it("responds 503 with a generic page that must not be cached", async function () {
      const res = await fetch(origin + "/redis");
      const body = await res.text();
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(body).toContain("Temporarily unavailable");
    });

    it("passes other errors on untouched", async function () {
      const res = await fetch(origin + "/other");
      expect(res.status).toBe(418);
      expect(await res.text()).toBe("passed on");
    });
  });
});
