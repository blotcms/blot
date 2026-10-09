describe("readOnly", function () {
  const Express = require("express");
  const fetch = require("node-fetch");
  const readOnly = require("helper/readOnly");

  global.test.timeout(15 * 1000);

  beforeEach(async function () {
    await readOnly.disable();
  });

  // A failing test must not leave the freeze on for other specs
  afterEach(async function () {
    await readOnly.disable();
  });

  describe("status", function () {
    it("is null when writes are allowed", async function () {
      expect(await readOnly.status()).toBe(null);
    });
  });

  describe("enable", function () {
    it("freezes writes, recording the reason, start time and a TTL", async function () {
      const before = Date.now();

      await readOnly.enable({ reason: "volume swap", ttl: 100 });

      const status = await readOnly.status();

      expect(status.reason).toBe("volume swap");
      expect(status.since).toBeGreaterThanOrEqual(before);
      expect(status.since).toBeLessThanOrEqual(Date.now());
      expect(status.expiresInSeconds).toBeGreaterThan(95);
      expect(status.expiresInSeconds).toBeLessThanOrEqual(100);
    });

    it("defaults to an empty reason and the default TTL", async function () {
      await readOnly.enable();

      const status = await readOnly.status();

      expect(status.reason).toBe("");
      expect(status.expiresInSeconds).toBeGreaterThan(
        readOnly.DEFAULT_TTL_SECONDS - 5
      );
      expect(status.expiresInSeconds).toBeLessThanOrEqual(
        readOnly.DEFAULT_TTL_SECONDS
      );
    });

    it("keeps the original start time and resets the TTL when enabled again", async function () {
      await readOnly.enable({ reason: "first", ttl: 30 });

      const first = await readOnly.status();

      await new Promise((resolve) => setTimeout(resolve, 20));
      await readOnly.enable({ reason: "second", ttl: 200 });

      const second = await readOnly.status();

      expect(second.since).toBe(first.since);
      expect(second.reason).toBe("second");
      expect(second.expiresInSeconds).toBeGreaterThan(30);
      expect(second.expiresInSeconds).toBeLessThanOrEqual(200);
    });

    it("rejects a TTL that is not a positive whole number", async function () {
      const invalid = [0, -1, 1.5, "60", NaN, Infinity, null];

      for (const ttl of invalid) {
        let error;

        try {
          await readOnly.enable({ reason: "bad", ttl });
        } catch (e) {
          error = e;
        }

        expect(error instanceof TypeError).toBe(true, "ttl " + String(ttl));
      }

      expect(await readOnly.status()).toBe(null);
    });
  });

  describe("disable", function () {
    it("lets writes through again", async function () {
      await readOnly.enable({ reason: "temporary", ttl: 100 });
      expect(await readOnly.status()).not.toBe(null);

      await readOnly.disable();
      expect(await readOnly.status()).toBe(null);
    });

    it("does nothing when writes are already allowed", async function () {
      await readOnly.disable();
      expect(await readOnly.status()).toBe(null);
    });
  });

  describe("whenWritable", function () {
    it("resolves immediately when writes are allowed", async function () {
      const started = Date.now();

      await readOnly.whenWritable("test");

      expect(Date.now() - started).toBeLessThan(900);
    });

    it("waits while frozen and resolves soon after the freeze lifts", async function () {
      spyOn(console, "log");

      await readOnly.enable({ reason: "waiting", ttl: 100 });

      let resolved = false;
      const waiting = readOnly.whenWritable("test").then(function () {
        resolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(resolved).toBe(false);

      await readOnly.disable();
      await waiting;

      expect(resolved).toBe(true);

      const logged = console.log.calls
        .allArgs()
        .map((args) => args.join(" "))
        .join("\n");

      expect(logged).toContain("[READ ONLY] waiting to write: test");
      expect(logged).toContain("[READ ONLY] resuming: test");
    });

    it("resolves once the freeze's TTL runs out", async function () {
      spyOn(console, "log");

      await readOnly.enable({ reason: "short", ttl: 1 });

      await readOnly.whenWritable("test");

      expect(await readOnly.status()).toBe(null);
    }, 20 * 1000);
  });

  describe("middleware", function () {
    let server, origin, seen;

    function allowedByHeader(req) {
      return req.get("x-allowed") === "yes";
    }

    function deniedByHeader(req) {
      return req.get("x-denied") === "yes";
    }

    beforeEach(function (done) {
      seen = [];

      const app = Express();

      app.use(
        readOnly.rejectWrites({
          allow: [allowedByHeader],
          deny: [deniedByHeader],
        })
      );
      app.use(function (req, res) {
        seen.push(req.method);
        res.send("handled");
      });

      server = app.listen(0, function () {
        origin = "http://127.0.0.1:" + server.address().port;
        done();
      });
    });

    afterEach(function (done) {
      server.close(done);
    });

    describe("rejectWrites", function () {
      it("passes every request when writes are allowed", async function () {
        for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"]) {
          const res = await fetch(origin + "/page", { method });

          expect(res.status).toBe(200, method);
        }

        expect(seen.length).toBe(6);
      });

      it("answers 503 with Retry-After to unsafe requests while frozen", async function () {
        await readOnly.enable({ reason: "maintenance", ttl: 100 });

        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          const res = await fetch(origin + "/page", { method });
          const body = await res.text();

          expect(res.status).toBe(503, method);
          expect(res.headers.get("retry-after")).toBe(
            String(readOnly.RETRY_AFTER_SECONDS)
          );
          expect(res.headers.get("cache-control")).toBe("no-store");
          expect(body).toContain("read-only");
        }

        expect(seen).toEqual([]);
      });

      it("passes GET, HEAD and OPTIONS while frozen", async function () {
        await readOnly.enable({ reason: "maintenance", ttl: 100 });

        for (const method of ["GET", "HEAD", "OPTIONS"]) {
          const res = await fetch(origin + "/page", { method });

          expect(res.status).toBe(200, method);
        }

        expect(seen).toEqual(["GET", "HEAD", "OPTIONS"]);
      });

      it("passes an unsafe request that an allow predicate matches while frozen", async function () {
        await readOnly.enable({ reason: "maintenance", ttl: 100 });

        const allowed = await fetch(origin + "/page", {
          method: "POST",
          headers: { "x-allowed": "yes" },
        });
        const rejected = await fetch(origin + "/page", { method: "POST" });

        expect(allowed.status).toBe(200);
        expect(rejected.status).toBe(503);
        expect(seen).toEqual(["POST"]);
      });

      it("passes writes again once the freeze is lifted", async function () {
        await readOnly.enable({ reason: "maintenance", ttl: 100 });
        expect((await fetch(origin + "/page", { method: "POST" })).status).toBe(
          503
        );

        await readOnly.disable();
        expect((await fetch(origin + "/page", { method: "POST" })).status).toBe(
          200
        );
      });

      describe("deny", function () {
        it("answers 503 with Retry-After to a denied GET while frozen", async function () {
          await readOnly.enable({ reason: "maintenance", ttl: 100 });

          const res = await fetch(origin + "/page", {
            headers: { "x-denied": "yes" },
          });
          const body = await res.text();

          expect(res.status).toBe(503);
          expect(res.headers.get("retry-after")).toBe(
            String(readOnly.RETRY_AFTER_SECONDS)
          );
          expect(res.headers.get("cache-control")).toBe("no-store");
          expect(body).toContain("read-only");
          expect(seen).toEqual([]);
        });

        it("passes a GET that no deny predicate matches while frozen", async function () {
          await readOnly.enable({ reason: "maintenance", ttl: 100 });

          const res = await fetch(origin + "/page");

          expect(res.status).toBe(200);
          expect(seen).toEqual(["GET"]);
        });

        it("rejects an unsafe request that matches both allow and deny while frozen", async function () {
          await readOnly.enable({ reason: "maintenance", ttl: 100 });

          const res = await fetch(origin + "/page", {
            method: "POST",
            headers: { "x-allowed": "yes", "x-denied": "yes" },
          });

          expect(res.status).toBe(503);
          expect(seen).toEqual([]);
        });

        it("passes a denied GET when writes are allowed", async function () {
          const res = await fetch(origin + "/page", {
            headers: { "x-denied": "yes" },
          });

          expect(res.status).toBe(200);
          expect(seen).toEqual(["GET"]);
        });
      });
    });
  });
});
