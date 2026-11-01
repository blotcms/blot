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
      const run = spyOn(sandbox, "run").and.returnValue(Promise.resolve({ meta: {}, outputs: [png] }));

      await screenshot("https://example.com", target, { width: 10, height: 20, untrusted: true });

      expect(run.calls.first().args.slice(0, 2)).toEqual([
        "screenshot",
        { url: "https://example.com", width: 10, height: 20, mobile: false },
      ]);
      expect((await fs.readFile(target)).equals(png)).toBe(true);
    });

    it("doesn't retry a page the job says won't change", async function () {
      const run = spyOn(sandbox, "run").and.returnValue(Promise.resolve({
        meta: { error: "net::ERR_NAME_NOT_RESOLVED", retryable: false },
        outputs: [],
      }));

      expect((await rejection(screenshot("https://nope.example", target))).message).toMatch(
        /ERR_NAME_NOT_RESOLVED/
      );
      expect(run).toHaveBeenCalledTimes(1);
      expect(await fs.pathExists(target)).toBe(false);
    });

    it("writes nothing that isn't a PNG", async function () {
      spyOn(sandbox, "run").and.returnValue(Promise.resolve({
        meta: {},
        outputs: [Buffer.from("<script>alert(1)</script>")],
      }));

      expect((await rejection(screenshot("https://example.com", target))).message).toMatch(
        /did not return a PNG/
      );
      expect(await fs.pathExists(target)).toBe(false);
    });
  });
});
