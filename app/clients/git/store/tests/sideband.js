// Progress reaching the user while a push works. The first group runs a real
// `git push` against a server whose object store is made slow, and looks at
// when the "remote:" lines arrive; the second checks the response framing.
const fs = require("fs");
const path = require("path");
const fx = require("./helpers/fixture");
const faults = require("./helpers/faults");
const timeout = require("./helpers/timeout");
const { createReceiveServer, push } = require("./helpers/receiveServer");
const manifest = require("../manifest");
const createResponse = require("../sideband");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");

const MASTER = "refs/heads/master";

// A response as the server sees it: what it was given to write, in order
function fakeResponse() {
  const res = { headersSent: false, destroyed: false, chunks: [], headers: {}, ended: false };
  res.setHeader = (name, value) => (res.headers[name] = value);
  res.writeHead = (status) => {
    res.status = status;
    res.headersSent = true;
  };
  res.write = (chunk) => res.chunks.push(Buffer.from(chunk));
  res.end = () => (res.ended = true);
  res.text = () => Buffer.concat(res.chunks).toString("latin1");
  return res;
}

describe("git store progress", function () {
  timeout(60 * 1000);

  describe("the response", function () {
    const commands = [{ old: "0".repeat(40), new: "a".repeat(40), ref: MASTER }];
    const ok = { status: "ok", results: [{ ref: MASTER }], messages: [] };

    it("writes progress on band 2 as it happens, then the report on band 1, then a flush", function () {
      const res = fakeResponse();
      const response = createResponse(res, { capabilities: "report-status side-band-64k", commands });

      response.progress("Checking the pack...");
      expect(res.status).toBe(200);
      expect(res.text()).toBe("001a\x02Checking the pack...\n");
      expect(res.ended).toBe(false);

      response.finish(ok);
      expect(res.text()).toBe("001a\x02Checking the pack...\n" + "0030\x01000eunpack ok\n0019ok refs/heads/master\n0000" + "0000");
      expect(res.ended).toBe(true);
    });

    it("sends no progress to a client which asked for quiet, but still the report", function () {
      const res = fakeResponse();
      const response = createResponse(res, { capabilities: "report-status side-band-64k quiet", commands });
      response.progress("Checking the pack...");
      expect(res.chunks).toEqual([]);

      response.finish(ok);
      expect(res.text()).not.toContain("Checking");
      expect(res.text()).toContain("ok refs/heads/master");
    });

    it("sends a client without side-band the plain report and nothing else", function () {
      const res = fakeResponse();
      const response = createResponse(res, { capabilities: "report-status", commands });
      response.progress("Checking the pack...");
      response.finish({ ...ok, messages: ["ignored"] });
      expect(res.text()).toBe("000eunpack ok\n0019ok refs/heads/master\n0000");
    });

    it("sends an empty band 1 packet when a stage is silent", async function () {
      const res = fakeResponse();
      const response = createResponse(res, { capabilities: "report-status side-band-64k", commands, keepaliveMs: 20 });
      response.progress("Saving to Blot...");
      // At least two keepalives, however late a loaded machine runs the timers
      for (let waited = 0; response.stats.keepalives < 2 && waited < 2000; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(res.text()).toContain("0005\x01");
      expect(response.stats.keepalives).toBeGreaterThan(1);

      response.finish(ok);
      const count = response.stats.keepalives;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(response.stats.keepalives).toBe(count);
    });

    it("reports every ref as failed, whatever was said before, when something other than a result ends it", function () {
      const res = fakeResponse();
      spyOn(console, "error");
      const response = createResponse(res, { capabilities: "report-status side-band-64k", commands });
      response.progress("Saving to Blot...");
      response.fail(new Error("boom"));

      expect(res.text()).toContain("ng refs/heads/master internal error");
      expect(res.text()).not.toContain("ok refs/heads/master");
      expect(res.text()).toContain("git fetch");
      expect(res.ended).toBe(true);
    });

    it("carries a refusal's messages and reports its refs as ng", function () {
      const res = fakeResponse();
      const response = createResponse(res, { capabilities: "report-status side-band-64k", commands });
      response.finish({
        status: "ok",
        results: [{ ref: MASTER, error: "missing necessary objects" }],
        messages: [MASTER + ": missing necessary objects", "Nothing was pushed."],
      });
      expect(res.text()).toContain("Nothing was pushed.");
      expect(res.text()).toContain("ng refs/heads/master missing necessary objects");
    });
  });

  describe("a real git push", function () {
    let dir;
    let src;
    let fixture;
    let store;
    let faulty;
    let server;

    beforeEach(async function () {
      dir = fx.tempDir();
      src = path.join(dir, "src");
      fixture = fx.buildFixture(src, { commits: 3, large: false });
      fx.repackAll(src);
      const [pack] = fx.readPacks(src);

      store = faulty = faults(createMemoryStore());
      const entry = await fx.upload(store, pack, fx.listEntries(pack).length);
      const base = manifest.empty();
      await manifest.swap({
        store,
        lock: (fn) => fn(),
        base,
        next: manifest.advance(base, { refs: { [MASTER]: fixture.head }, head: MASTER, packs: [entry] }),
      });

      const cache = createCache({ dir: path.join(dir, "cache"), maxBytes: 64 * 1024 * 1024 });
      server = await createReceiveServer({ store, cache, lock: (fn) => fn(), keepaliveMs: 100 });

      fx.git(src, ["checkout", "-q", "-b", "work"]);
      fs.writeFileSync(path.join(src, "docs", "big.txt"), fs.readFileSync(path.join(src, "docs", "big.txt"), "utf8").replace("line 3 ", "line 3 edited "));
      fx.git(src, ["commit", "-q", "-am", "Edit"]);
    });

    afterEach(async function () {
      await server.close();
      fx.remove(dir);
    });

    it("shows each stage as a remote line while the push is still working", async function () {
      // The upload is held open for a while after the stage before it has begun
      faulty.inject("put", { key: /\.pack$/, delay: 1500 });

      const pushed = await push(src, [server.url, "work:master"]);
      expect(pushed.code).toBe(0);

      const saving = pushed.events.find((event) => event.text.includes("remote: Saving to Blot..."));
      expect(saving).toBeDefined();
      expect(saving.at).toBeLessThan(pushed.endedAt - 1000);

      const lines = pushed.stderr.split("\n").filter((line) => line.startsWith("remote: "));
      const stages = ["Checking the pack...", "Fetching files the push builds on...", "Checking the new commits...", "Saving to Blot...", "Push saved."];
      expect(lines.map((line) => line.slice("remote: ".length).trim())).toEqual(stages);
    });

    it("keeps the connection alive through a silent stage, and the push still succeeds", async function () {
      faulty.inject("put", { key: /\.pack$/, delay: 1000 });

      const pushed = await push(src, [server.url, "work:master"]);
      expect(pushed.code).toBe(0);
      expect(server.responses[0].stats.keepalives).toBeGreaterThan(2);
      expect(server.results[0].outcome).toBe("ok");
      expect(pushed.stderr).not.toMatch(/error|fatal/i);
    });

    it("keeps a quiet push alive through a silent stage, without showing anything", async function () {
      faulty.inject("put", { key: /\.pack$/, delay: 1000 });

      const pushed = await push(src, ["-q", server.url, "work:master"]);
      expect(pushed.code).toBe(0);
      expect(pushed.stderr).not.toContain("remote:");
      expect(server.responses[0].stats.progress).toBe(0);
      expect(server.responses[0].stats.keepalives).toBeGreaterThan(2);
      expect(server.results[0].outcome).toBe("ok");
    });

    it("shows nothing from a quiet push", async function () {
      const pushed = await push(src, ["-q", server.url, "work:master"]);
      expect(pushed.code).toBe(0);
      expect(pushed.stderr).not.toContain("remote:");
      expect(server.responses[0].stats.progress).toBe(0);
    });

    it("never looks successful when the push fails after progress was shown", async function () {
      faulty.inject("put", { key: /\.pack$/, before: new Error("upload broke") });

      const pushed = await push(src, [server.url, "work:master"]);
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("remote: Saving to Blot...");
      expect(pushed.stderr).toContain("Nothing was pushed.");
      expect(pushed.stderr).toMatch(/rejected|failed/);
      expect((await manifest.read(store)).refs[MASTER]).toBe(fixture.head);
    });
  });
});
