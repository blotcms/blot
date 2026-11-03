describe("sandbox screenshot job", function () {
  const http = require("http");
  const fs = require("fs-extra");
  const os = require("os");
  const path = require("path");
  const config = require("config");
  const sandbox = require("../");
  const screenshot = require("helper/screenshot");

  const PNG = Buffer.from("89504e470d0a1a0a", "hex");
  const empty = Buffer.alloc(0);

  const rejection = (promise) =>
    promise.then(
      () => {
        throw new Error("expected a rejection");
      },
      (error) => error
    );

  let socket;

  beforeEach(function () {
    // no broker: the job runs in-process
    socket = config.sandbox.socket;
    config.sandbox.socket = "";
  });

  afterEach(function () {
    config.sandbox.socket = socket;
  });

  describe("the job", function () {
    const SLOW = 30000;

    let server;
    let url;

    beforeAll(function (done) {
      server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end("<h1>Hello</h1>");
      });
      server.listen(0, "127.0.0.1", () => {
        url = `http://127.0.0.1:${server.address().port}/`;
        done();
      });
    });

    afterAll(function (done) {
      server.close(done);
    });

    it("returns a PNG of the page", async function () {
      const { meta, outputs } = await sandbox.run("screenshot", { url }, empty);
      expect(meta.error).toBeUndefined();
      expect(outputs[0].subarray(0, 8).equals(PNG)).toBe(true);
    }, SLOW);

    it("returns a PNG the size of the viewport, in screen pixels", async function () {
      const sharp = require("sharp");
      const { outputs } = await sandbox.run(
        "screenshot",
        { url, width: 300, height: 200 },
        empty
      );
      const info = await sharp(outputs[0]).metadata();
      expect([info.width, info.height]).toEqual([600, 400]);
      expect(info.exif).toBeUndefined();
      expect(info.icc).toBeUndefined();
    }, SLOW);

    describe("a batch", function () {
      const sharp = require("sharp");
      const job = require("../jobs/screenshot");
      const { execSync } = require("child_process");

      const pngSize = async (png) => {
        const info = await sharp(png).metadata();
        return [info.width, info.height];
      };

      // Chromium is this process's child
      const killChromium = () => {
        try {
          const pids = execSync(`pgrep -P ${process.pid}`).toString().split("\n").filter(Boolean);
          for (const pid of pids) {
            try { process.kill(Number(pid), "SIGKILL"); } catch (e) {}
          }
        } catch (e) {}
      };

      let killer;
      beforeAll(function () {
        killer = http.createServer((req, res) => {
          if (req.url === "/kill") return killChromium();
          res.setHeader("Content-Type", "text/html");
          res.end("<h1>Hello</h1>");
        });
        return new Promise((resolve) => killer.listen(0, "127.0.0.1", resolve));
      });
      afterAll(function (done) {
        killer.close(done);
      });

      const closedPort = async () => {
        const closed = http.createServer();
        await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
        const { port } = closed.address();
        await new Promise((resolve) => closed.close(resolve));
        return `http://127.0.0.1:${port}/`;
      };

      it("returns one PNG per page, in order", async function () {
        const { meta, outputs } = await sandbox.run(
          "screenshot",
          { pages: [{ url, width: 300, height: 200 }, { url, width: 100, height: 50 }, { url: "about:blank", width: 200, height: 100 }] },
          empty
        );
        expect(meta.results).toEqual([{}, {}, {}]);
        expect(await Promise.all(outputs.map(pngSize))).toEqual([[600, 400], [200, 100], [400, 200]]);
      }, SLOW);

      it("keeps one page's failure to itself", async function () {
        const { meta, outputs } = await sandbox.run(
          "screenshot",
          { pages: [{ url }, { url: await closedPort() }, { url: "file:///etc/passwd" }, { url, width: 100000 }, { url }] },
          empty
        );
        expect(meta.results[0]).toEqual({});
        expect(meta.results[1].error).toMatch(/ERR_CONNECTION_REFUSED/);
        expect(meta.results[1].retryable).toBe(true);
        expect(meta.results[2]).toEqual({ error: "URL is not allowed", retryable: false });
        expect(meta.results[3].error).toBe("invalid dimension");
        expect(meta.results[3].retryable).toBe(false);
        expect(meta.results[4]).toEqual({});
        expect(outputs.map((o) => o.length > 0)).toEqual([true, false, false, false, true]);
      }, SLOW);

      it("takes no more than 8 pages, and at least one", async function () {
        const nine = Array.from({ length: 9 }, () => ({ url: "about:blank" }));
        for (const pages of [[], nine, "x"]) {
          const { meta, outputs } = await sandbox.run("screenshot", { pages }, empty);
          expect(meta.error).toBeDefined();
          expect(meta.retryable).toBe(false);
          expect(outputs).toEqual([]);
        }
      });

      it("gives what finished and defers the rest when Chromium dies", async function () {
        const base = `http://127.0.0.1:${killer.address().port}`;
        const { meta, outputs } = await sandbox.run(
          "screenshot",
          { pages: [{ url: base + "/" }, { url: base + "/kill" }, { url: base + "/" }] },
          empty
        );
        expect(meta.results[0]).toEqual({});
        expect(outputs[0].subarray(0, 8).equals(PNG)).toBe(true);
        expect(meta.results[1].retryable).toBe(true);
        expect(meta.results[1].deferred).toBeUndefined();
        expect(meta.results[2].deferred).toBe(true);
        expect(meta.results[2].retryable).toBe(true);
        expect(outputs[2].length).toBe(0);
      }, SLOW);

      describe("out of room", function () {
        let before;
        beforeEach(function () { before = { ...job.limits }; });
        afterEach(function () { Object.assign(job.limits, before); });

        it("defers the pages it hasn't time for, never the first", async function () {
          job.limits.batchBudget = 1;
          const { meta } = await sandbox.run("screenshot", { pages: [{ url }, { url }, { url }] }, empty);
          expect(meta.results[0]).toEqual({});
          expect(meta.results[1].deferred).toBe(true);
          expect(meta.results[2].deferred).toBe(true);
        }, SLOW);

        it("defers the pages that wouldn't fit in the reply, never the first", async function () {
          job.limits.maxOutputBytes = 1;
          const { meta, outputs } = await sandbox.run("screenshot", { pages: [{ url }, { url }] }, empty);
          expect(meta.results[0]).toEqual({});
          expect(outputs[0].length).toBeGreaterThan(1);
          expect(meta.results[1].deferred).toBe(true);
        }, SLOW);
      });
    });

    describe("re-encoding", function () {
      const sharp = require("sharp");
      const { reencode } = require("../jobs/screenshot");

      const chunks = (png) => {
        const names = [];
        for (let i = 8; i < png.length; i += 12 + png.readUInt32BE(i)) {
          names.push(png.toString("latin1", i + 4, i + 8));
        }
        return names;
      };

      it("drops metadata and ancillary chunks", async function () {
        const dirty = await sharp({
          create: { width: 20, height: 10, channels: 4, background: "#f00" },
        })
          .withMetadata({ exif: { IFD0: { Copyright: "hostile" } } })
          .png()
          .toBuffer();
        // a text chunk, which sharp can't write itself
        const text = Buffer.concat([
          Buffer.from([0, 0, 0, 3]),
          Buffer.from("tEXtk\0v", "latin1"),
          Buffer.alloc(4),
        ]);
        const end = dirty.length - 12;
        const withText = Buffer.concat([dirty.subarray(0, end), text, dirty.subarray(end)]);
        expect(chunks(withText)).toContain("tEXt");

        const clean = await reencode(withText, 20, 10);
        expect(chunks(clean).filter((c) => !["IHDR", "pHYs", "IDAT", "IEND"].includes(c))).toEqual([]);
        expect(clean.subarray(0, 8).equals(PNG)).toBe(true);
      });

      it("shrinks what is bigger than asked for and keeps its shape", async function () {
        const big = await sharp({
          create: { width: 400, height: 200, channels: 4, background: "#00f" },
        }).png().toBuffer();
        const info = await sharp(await reencode(big, 100, 100)).metadata();
        expect([info.width, info.height]).toEqual([100, 50]);
      });

      it("keeps transparency and doesn't enlarge", async function () {
        const small = await sharp({
          create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        }).png().toBuffer();
        const out = sharp(await reencode(small, 100, 100));
        const info = await out.metadata();
        expect([info.width, info.height, info.hasAlpha]).toEqual([10, 10, true]);
      });

      it("rejects bytes that aren't an image", async function () {
        await rejection(reencode(Buffer.concat([PNG, Buffer.from("junk")]), 10, 10));
      });
    });

    it("returns a PNG of a blank page, which is the deploy's check", async function () {
      const { outputs } = await sandbox.run("screenshot", { url: "about:blank" }, empty);
      expect(outputs[0].subarray(0, 8).equals(PNG)).toBe(true);
    }, SLOW);

    it("gives a page it can't reach back as an answer, not a failure", async function () {
      // A port that was just free, as Chromium won't try the low ones at all
      const closed = http.createServer();
      await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
      const { port } = closed.address();
      await new Promise((resolve) => closed.close(resolve));

      const { meta, outputs } = await sandbox.run(
        "screenshot",
        { url: `http://127.0.0.1:${port}/` },
        empty
      );
      expect(meta.error).toMatch(/ERR_CONNECTION_REFUSED/);
      expect(meta.retryable).toBe(true);
      expect(outputs).toEqual([]);
    }, SLOW);

    it("refuses anything but a web page, before starting a browser", async function () {
      for (const bad of ["file:///etc/passwd", "javascript:1", "not a url", undefined]) {
        const { meta, outputs } = await sandbox.run("screenshot", { url: bad }, empty);
        expect(meta.error).toBe("URL is not allowed");
        expect(meta.retryable).toBe(false);
        expect(outputs).toEqual([]);
      }
    });

    it("refuses a silly size", async function () {
      const { meta } = await sandbox.run(
        "screenshot",
        { url: "about:blank", width: 100000 },
        empty
      );
      expect(meta.error).toBe("invalid dimension");
    }, SLOW);
  });

  describe("helper/screenshot, when the browser is in the sandbox", function () {
    let directory;
    let target;

    beforeEach(async function () {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-screenshot-"));
      target = path.join(directory, "deep", "shot.png");
      config.sandbox.browser = true;
    });

    afterEach(async function () {
      config.sandbox.browser = false;
      await fs.remove(directory);
    });

    it("asks for the job, and writes what comes back", async function () {
      const png = Buffer.concat([PNG, Buffer.from("rest")]);
      const run = spyOn(sandbox, "run").and.returnValue(Promise.resolve({ meta: { results: [{}] }, outputs: [png] }));

      await screenshot("https://example.com", target, { width: 10, height: 20, untrusted: true });

      expect(run.calls.first().args.slice(0, 2)).toEqual([
        "screenshot",
        { pages: [{ url: "https://example.com", width: 10, height: 20, mobile: false }] },
      ]);
      expect((await fs.readFile(target)).equals(png)).toBe(true);
    });

    describe("batching", function () {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const png = (label) => Buffer.concat([PNG, Buffer.from(label)]);
      const ok = (labels) => ({
        meta: { results: labels.map(() => ({})) },
        outputs: labels.map(png),
      });
      const file = (name) => path.join(directory, name + ".png");
      const urls = (call) => (call.args || call)[1].pages.map((p) => p.url);

      it("sends requests that arrive together as one job and writes each its own", async function () {
        const run = spyOn(sandbox, "run").and.callFake(async (name, args) =>
          ok(args.pages.map((p) => p.url))
        );

        await Promise.all(["a", "b", "c"].map((n) => screenshot("https://" + n, file(n))));

        expect(run).toHaveBeenCalledTimes(1);
        expect(urls(run.calls.first())).toEqual(["https://a", "https://b", "https://c"]);
        for (const n of ["a", "b", "c"]) {
          expect((await fs.readFile(file(n))).equals(png("https://" + n))).toBe(true);
        }
      });

      it("sends a lone request after the window, not much later", async function () {
        const run = spyOn(sandbox, "run").and.callFake(async (name, args) =>
          ok(args.pages.map((p) => p.url))
        );
        const started = Date.now();
        await screenshot("https://a", file("a"));
        expect(Date.now() - started).toBeLessThan(screenshot.COALESCE_MS + 500);
        expect(run).toHaveBeenCalledTimes(1);
      });

      it("sends a full batch at once and the rest in the next", async function () {
        const run = spyOn(sandbox, "run").and.callFake(async (name, args) =>
          ok(args.pages.map((p) => p.url))
        );
        const names = Array.from({ length: screenshot.BATCH_MAX + 2 }, (_, i) => "p" + i);
        await Promise.all(names.map((n) => screenshot("https://" + n, file(n))));

        expect(run).toHaveBeenCalledTimes(2);
        expect(run.calls.argsFor(0)[1].pages.length).toBe(screenshot.BATCH_MAX);
        expect(urls(run.calls.argsFor(1))).toEqual(["https://p8", "https://p9"]);
      });

      it("collects what arrives while a batch runs, and sends it when that is done", async function () {
        let release;
        const first = new Promise((resolve) => (release = resolve));
        const run = spyOn(sandbox, "run").and.callFake(async (name, args) => {
          if (run.calls.count() === 1) await first;
          return ok(args.pages.map((p) => p.url));
        });

        const a = screenshot("https://a", file("a"));
        await wait(screenshot.COALESCE_MS + 100);
        expect(run).toHaveBeenCalledTimes(1);

        const later = [screenshot("https://b", file("b")), screenshot("https://c", file("c"))];
        await wait(screenshot.COALESCE_MS + 100);
        expect(run).toHaveBeenCalledTimes(1);

        release();
        await Promise.all([a, ...later]);
        expect(run).toHaveBeenCalledTimes(2);
        expect(urls(run.calls.argsFor(1))).toEqual(["https://b", "https://c"]);
      });

      it("keeps a page's failure to itself, and retries only what can change", async function () {
        const run = spyOn(sandbox, "run").and.callFake(async (name, args) => {
          const results = args.pages.map((p) => {
            if (p.url === "https://gone") return { error: "net::ERR_NAME_NOT_RESOLVED", retryable: false };
            if (p.url === "https://flaky" && run.calls.count() === 1) return { error: "reset", retryable: true };
            return {};
          });
          return { meta: { results }, outputs: args.pages.map((p, i) => (results[i].error ? empty : png(p.url))) };
        });

        const outcomes = await Promise.all([
          screenshot("https://good", file("good")).then(() => "ok", (e) => e.message),
          screenshot("https://gone", file("gone")).then(() => "ok", (e) => e.message),
          screenshot("https://flaky", file("flaky")).then(() => "ok", (e) => e.message),
        ]);

        expect(outcomes[0]).toBe("ok");
        expect(outcomes[1]).toMatch(/ERR_NAME_NOT_RESOLVED/);
        expect(outcomes[2]).toBe("ok");
        expect(await fs.pathExists(file("gone"))).toBe(false);
        // The batch, then flaky again alone
        expect(run).toHaveBeenCalledTimes(2);
        expect(urls(run.calls.argsFor(1))).toEqual(["https://flaky"]);
      }, 10000);

      it("sends pages the job didn't reach in the next batch, without a failed attempt", async function () {
        const run = spyOn(sandbox, "run").and.callFake(async (name, args) => {
          if (run.calls.count() <= 3) {
            // only the first of the pages each time
            return {
              meta: { results: args.pages.map((p, i) => (i ? { error: "late", retryable: true, deferred: true } : {})) },
              outputs: args.pages.map((p, i) => (i ? empty : png(p.url))),
            };
          }
          return ok(args.pages.map((p) => p.url));
        });

        await Promise.all(["a", "b", "c", "d", "e"].map((n) => screenshot("https://" + n, file(n))));
        // 3 passes where one page was done each, then the last two together
        expect(run).toHaveBeenCalledTimes(4);
        for (const n of ["a", "b", "c", "d", "e"]) expect(await fs.pathExists(file(n))).toBe(true);
      }, 10000);

      it("sends a batch the broker answered busy again, before failing its pages", async function () {
        const run = spyOn(sandbox, "run").and.callFake(async (name, args) => {
          if (run.calls.count() === 1) {
            throw Object.assign(new Error("sandbox: busy"), { code: "SANDBOX_BUSY" });
          }
          return ok(args.pages.map((p) => p.url));
        });

        await Promise.all([screenshot("https://a", file("a")), screenshot("https://b", file("b"))]);

        expect(run).toHaveBeenCalledTimes(2);
        expect(urls(run.calls.argsFor(1))).toEqual(["https://a", "https://b"]);
        expect(await fs.pathExists(file("b"))).toBe(true);
      }, screenshot.BUSY_DELAY_MS + 10000);

      ["SANDBOX_KILLED", "SANDBOX_TIMEOUT"].forEach(function (code) {
        it("sends each page alone when a batch ends in " + code, async function () {
          const heavy = "https://heavy";
          const run = spyOn(sandbox, "run").and.callFake(async (name, args) => {
            if (args.pages.length > 1 || args.pages[0].url === heavy) {
              throw Object.assign(new Error("sandbox: page"), { code });
            }
            return ok(args.pages.map((p) => p.url));
          });

          const outcomes = await Promise.all([
            screenshot("https://a", file("a")).then(() => "ok", () => "failed"),
            screenshot(heavy, file("heavy")).then(() => "ok", () => "failed"),
            screenshot("https://b", file("b")).then(() => "ok", () => "failed"),
          ]);

          // Only the heavy page pays, and it isn't tried again
          expect(outcomes).toEqual(["ok", "failed", "ok"]);
          expect(run).toHaveBeenCalledTimes(4);
          expect(run.calls.argsFor(0)[1].pages.length).toBe(3);
          expect(run.calls.allArgs().slice(1).map((a) => urls({ args: a }))).toEqual([
            ["https://a"],
            [heavy],
            ["https://b"],
          ]);
        });
      });
    });

    it("doesn't retry a page the job says won't change", async function () {
      const run = spyOn(sandbox, "run").and.returnValue(Promise.resolve({
        meta: { results: [{ error: "net::ERR_NAME_NOT_RESOLVED", retryable: false }] },
        outputs: [empty],
      }));

      expect((await rejection(screenshot("https://nope.example", target))).message).toMatch(
        /ERR_NAME_NOT_RESOLVED/
      );
      expect(run).toHaveBeenCalledTimes(1);
      expect(await fs.pathExists(target)).toBe(false);
    });

    ["SANDBOX_TIMEOUT", "SANDBOX_KILLED"].forEach(function (code) {
      it("doesn't retry a page that ends in " + code, async function () {
        const failure = Object.assign(new Error("sandbox: page"), { code });
        const run = spyOn(sandbox, "run").and.callFake(() => Promise.reject(failure));

        await rejection(screenshot("https://example.com", target));
        expect(run).toHaveBeenCalledTimes(1);
      });
    });

    it("writes nothing that isn't a PNG", async function () {
      spyOn(sandbox, "run").and.returnValue(Promise.resolve({
        meta: { results: [{}] },
        outputs: [Buffer.from("<script>alert(1)</script>")],
      }));

      expect((await rejection(screenshot("https://example.com", target))).message).toMatch(
        /did not return a PNG/
      );
      expect(await fs.pathExists(target)).toBe(false);
    });
  });
});
