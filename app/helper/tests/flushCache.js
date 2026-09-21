const flushCache = require("../flushCache");
const express = require("express");

describe("flushCache", function () {
  let BASE_PORT = 8400;

  beforeEach(function () {
    this.setup = ({ onPurge }) => {
      const app = express();
      const port = BASE_PORT++;
      const reverse_proxies = [`http://localhost:${port}`];

      app.get("/purge", onPurge);

      this.flush = flushCache({ reverse_proxies, requestsPerSecond: 1 });
      this.server = app.listen(port);

      return { port, reverse_proxies };
    };
  });

  afterEach(function () {
    if (this.server) {
      this.server.close();
    }
  });

  it("successfully flushes a single host", async function () {
    let purgeCount = 0;

    await this.setup({
      onPurge: (req, res) => {
        purgeCount++;
        expect(req.query.host).toEqual("example.com");
        res.send("ok");
      },
    });

    await this.flush("example.com");
    expect(purgeCount).toBe(1);
  });

  it("if you submit the same host multiple times, purge is merged", async function () {
    let purgeCount = 0;

    await this.setup({
      onPurge: (req, res) => {
        purgeCount++;
        expect(req.query.host).toEqual("example.com");
        res.send("ok");
      },
    });

    const purges = [];

    for (let i = 0; i < 10; i++) {
      purges.push(this.flush(["example.com", "example.com"]));
    }

    await Promise.all(purges);

    // the purge count should be less than the total number of purges
    // because the purges were merged
    expect(purgeCount).toBeLessThan(10);
    expect(purgeCount).toBeGreaterThan(0);
  });

  it("handles multiple hosts in a single request", async function () {
    const hosts = ["example1.com", "example2.com", "example3.com"];
    let receivedHosts;

    await this.setup({
      onPurge: (req, res) => {
        receivedHosts = Array.isArray(req.query.host)
          ? req.query.host
          : [req.query.host];
        res.send("ok");
      },
    });

    await this.flush(hosts);
    expect(receivedHosts).toEqual(hosts);
  });

  it("respects rate limiting", async function () {
    const timestamps = [];
    const { reverse_proxies } = await this.setup({
      onPurge: (req, res) => {
        timestamps.push(Date.now());
        res.send("ok");
      },
    });

    const flush = flushCache({ reverse_proxies, requestsPerSecond: 1 });

    const purges = [];

    for (let i = 0; i < 30; i++) {
      purges.push(flush(`example${i}.com`));
    }

    await Promise.all(purges);

    // purge will merge requests in batches of up to 10 hosts and process at most
    // one purge request per second, so we should have at least 3 batches of hosts
    // across at least 3 seconds

    console.log("timestamps", timestamps);

    const gaps = timestamps
      .slice(1)
      .map((timestamp, i) => timestamp - timestamps[i]);

    console.log("gaps", gaps);

    expect(timestamps.length).toBeGreaterThanOrEqual(3);
    expect(timestamps.at(-1) - timestamps[0]).toBeGreaterThanOrEqual(3000);
  });

  it("handles failed requests appropriately", async function (done) {
    await this.setup({
      onPurge: (req, res) => res.status(500).send("error"),
    });

    try {
      await this.flush("example.com");
      done.fail("Should have thrown an error");
    } catch (error) {
      expect(error instanceof Error).toBe(true);
      done();
    }
  });

  it("handles multiple reverse proxies", async function () {
    const app1 = express();
    const app2 = express();
    const port1 = BASE_PORT++;
    const port2 = BASE_PORT++;

    let proxy1Called = false;
    let proxy2Called = false;

    app1.get("/purge", (req, res) => {
      proxy1Called = true;
      res.send("ok");
    });

    app2.get("/purge", (req, res) => {
      proxy2Called = true;
      res.send("ok");
    });

    const server1 = app1.listen(port1);
    const server2 = app2.listen(port2);

    const flush = flushCache({
      reverse_proxies: [
        `http://localhost:${port1}`,
        `http://localhost:${port2}`,
      ],
      requestsPerSecond: 10,
    });

    await flush("example.com");

    expect(proxy1Called).toBe(true);
    expect(proxy2Called).toBe(true);

    server1.close();
    server2.close();
  });

  it("validates input parameters", async function (done) {
    await this.setup({
      onPurge: (req, res) => res.send("ok"),
    });

    try {
      await this.flush({ invalid: "input" });
      done.fail("Should have thrown an error");
    } catch (error) {
      expect(error instanceof Error).toBe(true);
      done();
    }
  });

  it("handles network errors gracefully", async function () {
    const flush = flushCache({
      // nothing listens here, so the connection is refused
      reverse_proxies: ["http://127.0.0.1:1"],
      requestsPerSecond: 10,
    });

    let error;

    try {
      await flush("example.com");
    } catch (e) {
      error = e;
    }

    expect(error instanceof Error).toBe(true);
    expect(error.message).toContain("http://127.0.0.1:1");
  });

  describe("with several proxies", function () {
    const servers = [];

    // Starts a fake proxy which counts and answers /purge requests
    const startProxy = (onPurge) => {
      const app = express();
      const port = BASE_PORT++;
      const proxy = { url: `http://localhost:${port}`, purges: [], headers: [] };

      app.get("/purge", (req, res) => {
        proxy.purges.push(req.query.host);
        proxy.headers.push(req.headers);
        onPurge(req, res);
      });

      servers.push(app.listen(port));
      return proxy;
    };

    afterEach(function () {
      while (servers.length) servers.pop().close();
    });

    // Minimal in-memory version of helper/flushCachePending
    const memoryPending = () => {
      const store = {};
      const clock = { now: 1000 };
      return {
        store,
        async add(target, hosts) {
          store[target] = store[target] || {};
          clock.now++;
          hosts.forEach((host) => (store[target][host] = clock.now));
        },
        async list(target) {
          return Object.entries(store[target] || {}).map(([host, score]) => ({
            host,
            score,
          }));
        },
        async remove(target, entries) {
          entries.forEach(({ host, score }) => {
            if (store[target] && store[target][host] === score)
              delete store[target][host];
          });
        },
      };
    };

    it("still purges the other proxies when one fails", async function () {
      const broken = startProxy((req, res) => res.status(500).send("error"));
      const healthy = startProxy((req, res) => res.send("ok"));

      const flush = flushCache({
        reverse_proxies: [broken.url, healthy.url],
        requestsPerSecond: 100,
      });

      let error;

      try {
        await flush("example.com");
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
      expect(error.message).toContain(broken.url);
      expect(healthy.purges).toEqual(["example.com"]);
    });

    it("gives up on a proxy which does not respond", async function () {
      const hung = startProxy(() => {
        /* never answers */
      });
      const healthy = startProxy((req, res) => res.send("ok"));

      const flush = flushCache({
        reverse_proxies: [hung.url, healthy.url],
        requestsPerSecond: 100,
        timeoutMs: 200,
      });

      let error;
      const started = Date.now();

      try {
        await flush("example.com");
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
      expect(error.message).toContain("timed out");
      expect(Date.now() - started).toBeLessThan(2000);
      expect(healthy.purges).toEqual(["example.com"]);
    });

    it("keeps purging queued hosts after a proxy fails", async function () {
      const broken = startProxy((req, res) => res.status(500).send("error"));

      const flush = flushCache({
        reverse_proxies: [broken.url],
        requestsPerSecond: 100,
        maxHostsPerPurge: 1,
      });

      const results = await Promise.all(
        ["a.example", "b.example", "c.example"].map((host) =>
          flush(host).then(
            () => "ok",
            () => "failed"
          )
        )
      );

      expect(results).toEqual(["failed", "failed", "failed"]);
      expect(broken.purges.sort()).toEqual(["a.example", "b.example", "c.example"]);
    });

    it("sends the purge token when configured", async function () {
      const proxy = startProxy((req, res) => res.send("ok"));

      const flush = flushCache({
        reverse_proxies: [proxy.url],
        requestsPerSecond: 100,
        token: "secret",
      });

      await flush("example.com");

      expect(proxy.headers[0]["x-blot-purge-token"]).toEqual("secret");
    });

    it("does not send a token header when none is configured", async function () {
      const proxy = startProxy((req, res) => res.send("ok"));

      const flush = flushCache({
        reverse_proxies: [proxy.url],
        requestsPerSecond: 100,
      });

      await flush("example.com");

      expect(proxy.headers[0]["x-blot-purge-token"]).toBeUndefined();
    });

    it("records hosts a proxy missed and retries them until it recovers", async function () {
      let down = true;
      const proxy = startProxy((req, res) =>
        down ? res.status(503).send("down") : res.send("ok")
      );
      const healthy = startProxy((req, res) => res.send("ok"));
      const pending = memoryPending();

      const flush = flushCache({
        reverse_proxies: [proxy.url, healthy.url],
        requestsPerSecond: 100,
        pending,
        retryIntervalMs: 0, // drive retries by hand
      });

      try {
        await flush(["a.example", "b.example"]);
      } catch (e) {}

      // only the proxy which failed has anything pending
      expect(Object.keys(pending.store[proxy.url]).sort()).toEqual([
        "a.example",
        "b.example",
      ]);
      expect(pending.store[healthy.url]).toBeUndefined();

      // still down: the entries are kept
      await flush.retryPending();
      expect(Object.keys(pending.store[proxy.url]).length).toBe(2);

      down = false;
      proxy.purges.length = 0;
      await flush.retryPending();

      expect(proxy.purges.length).toBe(1);
      expect(pending.store[proxy.url]).toEqual({});
    });

    it("does not drop a purge which failed again while a retry was running", async function () {
      const pending = memoryPending();
      let proxyURL;

      const proxy = startProxy((req, res) => {
        // while the retry is in flight, the same host fails to purge again
        pending.add(proxyURL, ["a.example"]).then(() => res.send("ok"));
      });
      proxyURL = proxy.url;

      await pending.add(proxyURL, ["a.example"]);

      const flush = flushCache({
        reverse_proxies: [proxyURL],
        requestsPerSecond: 100,
        pending,
        retryIntervalMs: 0,
      });

      await flush.retryPending();

      expect(Object.keys(pending.store[proxyURL])).toEqual(["a.example"]);
    });
  });
});
