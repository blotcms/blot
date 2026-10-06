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

    it("recognises a server that is still loading its dataset", function () {
      const { ErrorReply } = require("redis");
      expect(
        isRedisUnavailableError(
          new ErrorReply("LOADING Redis is loading the dataset in memory")
        )
      ).toBe(true);
      expect(isRedisUnavailableError(new ErrorReply("MASTERDOWN Link down"))).toBe(true);
    });

    it("ignores other error replies", function () {
      const { ErrorReply } = require("redis");
      expect(
        isRedisUnavailableError(new ErrorReply("WRONGTYPE Operation against a key"))
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
