const fs = require("fs");
const os = require("os");
const path = require("path");
const { select, run, readState, startState, parseArgs } = require("../reconcile");

const MINUTE = 60 * 1000;
const SINCE = Date.parse("2026-11-01T03:00:00Z");
const blog = (id, client, minutesAfter, extra) =>
  Object.assign({ id, client, cacheID: minutesAfter === null ? undefined : SINCE + minutesAfter * MINUTE }, extra);

describe("host-cycle reconcile", function () {
  describe("select", function () {
    it("takes sync-client blogs changed since the snapshot, most recent first", function () {
      const plan = select(
        [
          blog("old", "dropbox", -120),
          blog("a", "dropbox", 5),
          blog("b", "google-drive", 40),
          blog("c", "icloud", 20),
          blog("plain", "", 30),
        ],
        { since: SINCE }
      );

      expect(plan.resync.map((b) => b.id)).toEqual(["b", "c", "a"]);
      expect(plan.unchanged).toBe(1);
    });

    it("looks back by the margin, and includes a blog it cannot rule out", function () {
      const blogs = [blog("near", "dropbox", -10), blog("unknown", "dropbox", null), blog("far", "dropbox", -60)];
      const plan = select(blogs, { since: SINCE, marginMs: 15 * MINUTE });

      expect(plan.resync.map((b) => b.id)).toEqual(["near", "unknown"]);
    });

    it("leaves out disabled blogs and takes everything with --all", function () {
      const blogs = [blog("a", "dropbox", -500), blog("gone", "dropbox", 5, { isDisabled: true })];

      expect(select(blogs, { since: SINCE }).resync).toEqual([]);
      expect(select(blogs, { since: SINCE, all: true }).resync.map((b) => b.id)).toEqual(["a"]);
    });

    it("lists git blogs apart, never to be resynced", function () {
      const plan = select([blog("g1", "git", 3), blog("g2", "git", 30), blog("g0", "git", -90)], { since: SINCE });

      expect(plan.resync).toEqual([]);
      expect(plan.git.map((b) => b.id)).toEqual(["g2", "g1"]);
    });
  });

  describe("state", function () {
    let file;
    beforeEach(function () {
      file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-")), "state.txt");
    });

    it("is empty before a first run and returns what a run finished", function () {
      const since = new Date(SINCE);
      expect(readState(file, since).size).toBe(0);

      startState(file, since);
      fs.appendFileSync(file, "a\nb\n");

      expect([...readState(file, since)]).toEqual(["a", "b"]);
    });

    it("refuses a file written for another snapshot", function () {
      startState(file, new Date(SINCE));

      expect(() => readState(file, new Date(SINCE + MINUTE))).toThrowError(/another --since/);
    });
  });

  describe("run", function () {
    const options = (extra) =>
      Object.assign({ concurrency: 2, perClient: 1, pauseMs: 0, sleep: () => new Promise((r) => setImmediate(r)) }, extra);

    it("resyncs each blog once, records it, and does not record a failure", async function () {
      const finished = [];
      const result = await run(
        [blog("a", "dropbox", 1), blog("b", "dropbox", 2), blog("c", "icloud", 3)],
        options({
          resync: async (b) => {
            if (b.id === "b") throw new Error("boom");
          },
          finished: (id) => finished.push(id),
        })
      );

      expect(finished.sort()).toEqual(["a", "c"]);
      expect(result.done).toBe(2);
      expect(result.failures).toEqual([{ id: "b", client: "dropbox", message: "boom" }]);
    });

    it("starts blogs in the order given", async function () {
      const started = [];
      await run(
        [blog("first", "dropbox", 9), blog("second", "icloud", 8), blog("third", "dropbox", 7)],
        options({ concurrency: 1, resync: async (b) => started.push(b.id), finished: () => {} })
      );

      expect(started).toEqual(["first", "second", "third"]);
    });

    it("keeps to the per-client and overall limits", async function () {
      let active = 0;
      let dropbox = 0;
      const peak = { all: 0, dropbox: 0 };
      const blogs = ["a", "b", "c", "d"].map((id) => blog(id, "dropbox", 1)).concat(blog("e", "icloud", 1), blog("f", "icloud", 1));

      await run(
        blogs,
        options({
          concurrency: 3,
          perClient: 1,
          resync: async (b) => {
            active++;
            if (b.client === "dropbox") dropbox++;
            peak.all = Math.max(peak.all, active);
            peak.dropbox = Math.max(peak.dropbox, dropbox);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            if (b.client === "dropbox") dropbox--;
          },
          finished: () => {},
        })
      );

      expect(peak.dropbox).toBe(1);
      expect(peak.all).toBeLessThanOrEqual(3);
      expect(peak.all).toBeGreaterThan(1);
    });

    it("resumes: a second run does only what the first did not finish", async function () {
      const blogs = [blog("a", "dropbox", 3), blog("b", "dropbox", 2), blog("c", "dropbox", 1)];
      const finished = new Set();

      await run(blogs, options({
        resync: async (b) => {
          if (b.id === "b") throw new Error("locked");
        },
        finished: (id) => finished.add(id),
      }));
      expect([...finished].sort()).toEqual(["a", "c"]);

      const again = [];
      await run(blogs.filter((b) => !finished.has(b.id)), options({
        resync: async (b) => again.push(b.id),
        finished: (id) => finished.add(id),
      }));

      expect(again).toEqual(["b"]);
      expect(finished.size).toBe(3);
    });
  });

  describe("parseArgs", function () {
    it("needs --since and takes one or the other of --go and --dry-run", function () {
      expect(() => parseArgs([])).toThrowError(/--since/);
      expect(() => parseArgs(["--since", "not a time"])).toThrowError(/--since/);
      expect(() => parseArgs(["--since", "2026-11-01T03:00:00Z", "--go", "--dry-run"])).toThrowError(/not both/);
      expect(parseArgs(["--since", "2026-11-01T03:00:00Z"]).go).toBeUndefined();
    });
  });
});
