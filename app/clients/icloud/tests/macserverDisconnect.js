// The macserver is an ESM app with its own dependencies (dotenv), so these
// specs register a small resolve hook that stubs dotenv when it isn't installed
// and, for watcher/actions.js only, swaps the httpClient modules for spies
// held on globalThis.__macserverMocks.
const http = require("http");
const os = require("os");
const path = require("path");
const { register } = require("module");
const { pathToFileURL } = require("url");

const macserverDir = path.join(__dirname, "../macserver");
const load = (file) => import(pathToFileURL(path.join(macserverDir, file)).href);

const hooks = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "dotenv/config") {
    try {
      return await nextResolve(specifier, context);
    } catch (e) {
      return { url: "data:text/javascript,", shortCircuit: true };
    }
  }
  const match = /httpClient\\/(upload|remove|mkdir|resync)\\.js$/.exec(specifier);
  if (match && context.parentURL && context.parentURL.endsWith("/watcher/actions.js")) {
    return {
      url: "data:text/javascript,export default (...args) => globalThis.__macserverMocks." + match[1] + "(...args)",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;

describe("icloud macserver disconnect handling", function () {
  let server;
  let requests;
  let respond;
  let limiters;
  let actions;
  let resync;
  let blogCounter = 0;

  const newBlogID = () => `blog_${process.pid}_${blogCounter++}`;

  beforeAll(async function () {
    register("data:text/javascript," + encodeURIComponent(hooks));

    // resync.js reads these through config.js when it is first imported
    server = http.createServer((req, res) => {
      requests++;
      const status = respond(requests);
      res.writeHead(status);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env = {
      REMOTE_SERVER: `http://127.0.0.1:${server.address().port}`,
      ICLOUD_DRIVE_DIRECTORY: os.tmpdir(),
      BLOT_ICLOUD_SERVER_SECRET: "test-secret",
    };
    const previous = {};
    for (const key in env) {
      previous[key] = process.env[key];
      process.env[key] = env[key];
    }

    globalThis.__macserverMocks = {};
    try {
      limiters = await load("limiters.js");
      actions = await load("watcher/actions.js");
      resync = (await load("httpClient/resync.js")).default;
    } finally {
      // config.js has read them by now; don't leak them into other specs
      for (const key in previous) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  afterAll(function (done) {
    delete globalThis.__macserverMocks;
    server.closeAllConnections();
    server.close(() => done());
  });

  beforeEach(function () {
    requests = 0;
    respond = () => 200;
    globalThis.__macserverMocks.upload = jasmine.createSpy("upload").and.callFake(async () => {});
    globalThis.__macserverMocks.remove = jasmine.createSpy("remove").and.callFake(async () => {});
    globalThis.__macserverMocks.mkdir = jasmine.createSpy("mkdir").and.callFake(async () => true);
    globalThis.__macserverMocks.resync = jasmine.createSpy("resync").and.callFake(async () => {});
    spyOn(console, "log");
    spyOn(console, "warn");
    spyOn(console, "error");
  });

  describe("removeLimiterForBlogID", function () {
    it("drops waiting jobs, lets the running job finish and rejects the dropped ones", async function () {
      const blogID = newBlogID();
      const limiter = limiters.getLimiterForBlogID(blogID);
      let release;
      const ran = [];

      const running = limiter.schedule(
        () => new Promise((resolve) => (release = () => resolve("done")))
      );
      const waiting = [1, 2].map((n) =>
        limiter.schedule(async () => ran.push(n)).catch((error) => error)
      );

      // let the first job start
      await new Promise((resolve) => setTimeout(resolve, 20));

      limiters.removeLimiterForBlogID(blogID);
      release();

      expect(await running).toBe("done");
      const errors = await Promise.all(waiting);
      expect(errors.every(limiters.isLimiterStoppedError)).toBe(true);
      expect(ran).toEqual([]);
    });

    it("does not throw for a blog without a limiter", function () {
      expect(() => limiters.removeLimiterForBlogID(newBlogID())).not.toThrow();
    });
  });

  describe("performAction", function () {
    it("quietly drops queued actions after the limiter is removed, without a resync", async function () {
      const blogID = newBlogID();
      let release;
      globalThis.__macserverMocks.remove.and.callFake(
        () => new Promise((resolve) => (release = resolve))
      );

      const results = [
        actions.performAction(blogID, "/a.txt", "remove"),
        actions.performAction(blogID, "/b.txt", "remove"),
        actions.performAction(blogID, "/c.txt", "remove"),
      ];
      // let the first job start
      await new Promise((resolve) => setTimeout(resolve, 20));

      limiters.removeLimiterForBlogID(blogID);
      release();

      // none of them reject
      await Promise.all(results);
      expect(globalThis.__macserverMocks.remove).toHaveBeenCalledTimes(1);
      expect(globalThis.__macserverMocks.resync).not.toHaveBeenCalled();
    });

    it("drops actions that arrive after the disconnect until the blog is watched again", async function () {
      const blogID = newBlogID();
      limiters.removeLimiterForBlogID(blogID);

      await actions.performAction(blogID, "/late.txt", "remove");
      expect(globalThis.__macserverMocks.remove).not.toHaveBeenCalled();
      expect(globalThis.__macserverMocks.resync).not.toHaveBeenCalled();

      limiters.reviveLimiterForBlogID(blogID);
      await actions.performAction(blogID, "/late.txt", "remove");
      expect(globalThis.__macserverMocks.remove).toHaveBeenCalledTimes(1);
    });

    it("still requests a resync and rejects when an action fails", async function () {
      const blogID = newBlogID();
      const failure = new Error("boom");
      globalThis.__macserverMocks.remove.and.callFake(async () => {
        throw failure;
      });

      let caught;
      try {
        await actions.performAction(blogID, "/a.txt", "remove");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(failure);
      expect(globalThis.__macserverMocks.resync).toHaveBeenCalledTimes(1);
    });
  });

  describe("resync", function () {
    it("gives up after one attempt when Blot answers 400", async function () {
      respond = () => 400;

      await resync(newBlogID(), "remove failed");

      // one attempt is the fetch wrapper's own three tries; a second attempt
      // (after the 1s backoff) would make six
      expect(requests).toBe(3);
      const logged = console.log.calls.allArgs().map((args) => args.join(" "));
      expect(logged.some((line) => /Resync not needed: blog .* is no longer connected/.test(line))).toBe(true);
    });

    [409, 423, 500].forEach(function (status) {
      it(`keeps retrying when Blot answers ${status}`, async function () {
        // fail the first attempt (3 requests), succeed on the second
        respond = (n) => (n <= 3 ? status : 200);

        await resync(newBlogID(), "remove failed");

        expect(requests).toBe(4);
      });
    });
  });
});
