// The hourly sweep (init.js validateAllBlogs): which blogs it walks, how it
// treats a busy lock or a refused walk, and what ends up in the one
// ICLOUD_SYNC_ISSUE digest it sends.
describe("icloud init validateAllBlogs", function () {
  const paths = {
    blog: require.resolve("models/blog"),
    entries: require.resolve("models/entries"),
    database: require.resolve("../database"),
    fromiCloud: require.resolve("../sync/fromiCloud"),
    lock: require.resolve("sync/establishSyncLock"),
    folderLock: require.resolve("sync/lock"),
    fix: require.resolve("sync/fix"),
    email: require.resolve("helper/email"),
    getHealth: require.resolve("../getHealth"),
    redis: require.resolve("models/client"),
    init: require.resolve("../init"),
  };
  const originals = {};
  const HOUR = 60 * 60 * 1000;
  // What the digest remembers having reported (see syncReport), as a fake of
  // the Redis set it lives in. Kept across sweeps within a test.
  let reported;

  beforeEach(function () {
    reported = new Set();
    Object.keys(paths).forEach((name) => {
      originals[name] = require.cache[paths[name]];
    });
  });

  afterEach(function () {
    Object.keys(paths).forEach((name) => {
      if (originals[name]) require.cache[paths[name]] = originals[name];
      else delete require.cache[paths[name]];
    });
  });

  const stub = (name, exports) => {
    require.cache[paths[name]] = {
      id: paths[name],
      filename: paths[name],
      loaded: true,
      exports,
    };
  };

  // behaviors: { [blogID]: { account, summary, walkError, busy, disabled,
  // heldSince, fixReport, fixError, accountAfterLock, gate, blogDisabled,
  // health } }. health is a getHealth result, an Error to throw, or a function
  // of how many times the blog's health has been read (a blog's folder can
  // vanish mid-sweep); by default it follows the stored account, like the real
  // thing. Calls are recorded in `calls`: { walked: [blogID], fixed: [blogID],
  // locked: [blogID] }.
  function load(behaviors, sentEmails, calls) {
    const ids = Object.keys(behaviors);
    const healthReads = {};

    stub("blog", {
      get: ({ id }, callback) =>
        callback(null, {
          id,
          handle: id + "-handle",
          client: "icloud",
          isDisabled: Boolean(behaviors[id].blogDisabled),
        }),
    });
    stub("entries", {
      getAllTotal: (_id, callback) => callback(null, 42),
    });
    stub("database", {
      iterate: async (callback) => {
        for (const id of ids) {
          const account = Object.assign(
            { setupComplete: true, lastSync: Date.now() },
            behaviors[id].account
          );
          await callback(id, account);
        }
      },
      // What the sweep re-reads once it holds the lock
      get: async (id) =>
        Object.assign(
          { setupComplete: true, lastSync: Date.now() },
          behaviors[id].account,
          behaviors[id].accountAfterLock
        ),
    });
    stub("lock", function (blogID) {
      calls.locked.push(blogID);
      if (behaviors[blogID].busy) {
        return Promise.reject(new Error("Failed to acquire folder lock"));
      }
      if (behaviors[blogID].disabled) {
        return Promise.reject(new Error("Cannot sync blog " + blogID));
      }
      return Promise.resolve({
        folder: { update: async () => {} },
        done: async function () {},
      });
    });
    stub("fromiCloud", async function (blogID) {
      calls.walked.push(blogID);
      const behavior = behaviors[blogID];
      if (behavior.gate) await behavior.gate;
      if (behavior.walkError) throw behavior.walkError;
      return Object.assign({ failed: 0, firstError: null }, behavior.summary);
    });
    stub("folderLock", {
      heldSince: async (blogID) => behaviors[blogID].heldSince || null,
    });
    stub("fix", function (blog, callback) {
      calls.fixed.push(blog.id);
      const behavior = behaviors[blog.id];
      callback(behavior.fixError || null, behavior.fixReport || {});
    });
    stub("getHealth", async function (blogID) {
      const health = require("clients/health");
      const { resolveIssue } = require("../error");
      let result = behaviors[blogID].health;
      healthReads[blogID] = (healthReads[blogID] || 0) + 1;
      if (typeof result === "function") result = result(healthReads[blogID]);
      if (result instanceof Error) throw result;
      if (result) return result;
      const issue = resolveIssue(
        Object.assign({ setupComplete: true }, behaviors[blogID].account)
      );
      return issue ? health.error([issue]) : health.ok();
    });
    stub("redis", {
      sMembers: async () => Array.from(reported),
      multi: function () {
        const ops = [];
        const multi = {
          del: () => (ops.push(() => reported.clear()), multi),
          sAdd: (key, ids) => (
            ops.push(() => ids.forEach((id) => reported.add(id))), multi
          ),
          exec: async () => ops.forEach((op) => op()),
        };
        return multi;
      },
    });
    stub("email", {
      ICLOUD_SYNC_ISSUE: function (uid, locals, callback) {
        sentEmails.push(locals);
        callback();
      },
    });
    delete require.cache[paths.init];
    return require("../init");
  }

  const stamp = Date.now();
  const id = (name) => "blog_icloudsweep" + name + stamp;

  function setup(behaviors) {
    const sentEmails = [];
    const calls = { walked: [], fixed: [], locked: [] };
    const init = load(behaviors, sentEmails, calls);
    return { init, sentEmails, calls };
  }

  const byID = (email) => {
    const result = {};
    email.blogs.forEach((blog) => (result[blog.id] = blog));
    return result;
  };

  it("sends one email with the changes a walk found", async function () {
    const { init, sentEmails } = setup({
      [id("changes")]: { summary: { downloaded: 2, removed: 1, createdDirs: 1 } },
    });

    await init.validateAllBlogs();

    expect(sentEmails.length).toEqual(1);
    const record = byID(sentEmails[0])[id("changes")];
    expect(record.changeCount).toEqual(4);
    expect(record.downloaded).toEqual(2);
    expect(record.removed).toEqual(1);
    expect(record.createdDirs).toEqual(1);
  });

  it("sends nothing when no blog has a problem", async function () {
    const { init, sentEmails, calls } = setup({
      [id("clean")]: { summary: {} },
      // An edit that landed mid-walk isn't a missed change
      [id("live")]: { summary: { downloaded: 1, modifiedDuringWalk: 1 } },
    });

    await init.validateAllBlogs();

    expect(calls.walked.length).toEqual(2);
    expect(sentEmails.length).toEqual(0);
  });

  it("skips a blog the macserver hasn't pushed to in the last hour, or never", async function () {
    const { init, sentEmails, calls } = setup({
      [id("stale")]: {
        account: { lastSync: Date.now() - 2 * HOUR },
        summary: { downloaded: 5 },
      },
      [id("never")]: {
        account: { lastSync: undefined },
        summary: { downloaded: 5 },
      },
      [id("recent")]: {
        account: { lastSync: Date.now() - HOUR / 2 },
        summary: {},
      },
    });

    await init.validateAllBlogs();

    expect(calls.locked).toEqual([id("recent")]);
    expect(calls.walked).toEqual([id("recent")]);
    expect(sentEmails.length).toEqual(0);
  });

  it("skips a blog whose setup is incomplete or has a stored error", async function () {
    const { init, sentEmails, calls } = setup({
      [id("setup")]: { account: { setupComplete: false }, summary: { downloaded: 1 } },
      [id("error")]: { account: { error: "Blog directory deleted" }, summary: { downloaded: 1 } },
      [id("transfer")]: { account: { transferringToiCloud: true }, summary: { downloaded: 1 } },
    });

    await init.validateAllBlogs();

    expect(calls.locked).toEqual([]);
    expect(sentEmails.length).toEqual(0);
  });

  it("skips and doesn't report a blog whose account became unfit once the lock was held", async function () {
    const { init, sentEmails, calls } = setup({
      [id("late")]: {
        accountAfterLock: { error: "Blog directory deleted" },
        summary: { downloaded: 3 },
      },
    });

    await init.validateAllBlogs();

    expect(calls.locked).toEqual([id("late")]);
    // Walking it would remove Blot's files, and nothing else follows
    expect(calls.walked).toEqual([]);
    expect(calls.fixed).toEqual([]);
    expect(sentEmails.length).toEqual(0);
  });

  it("skips a busy blog, reporting it only when the lock looks stuck", async function () {
    const { init, sentEmails, calls } = setup({
      [id("stuck")]: { busy: true, heldSince: Date.now() - 3 * HOUR },
      [id("briefly")]: { busy: true, heldSince: Date.now() - 1000 },
    });

    await init.validateAllBlogs();

    expect(calls.walked).toEqual([]);
    expect(calls.fixed).toEqual([]);
    expect(sentEmails.length).toEqual(1);
    const records = byID(sentEmails[0]);
    expect(Object.keys(records)).toEqual([id("stuck")]);
    expect(records[id("stuck")].hasStuckLock).toEqual(true);
    expect(records[id("stuck")].lockHeldFor).toEqual("3h 0m");
  });

  it("silently skips a blog that was disabled", async function () {
    const { init, sentEmails, calls } = setup({
      [id("disabled")]: { disabled: true },
    });

    spyOn(console, "error");
    await init.validateAllBlogs();

    expect(calls.walked).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
    expect(sentEmails.length).toEqual(0);
  });

  it("reports a walk that threw, and doesn't run Fix", async function () {
    const { init, sentEmails, calls } = setup({
      [id("threw")]: { walkError: new Error("walk exploded") },
    });

    spyOn(console, "error");
    await init.validateAllBlogs();

    expect(calls.fixed).toEqual([]);
    const record = byID(sentEmails[0])[id("threw")];
    expect(record.errors).toEqual([{ phase: "walk", message: "walk exploded" }]);
  });

  it("reports a walk that swallowed failures, however clean its counts look, and doesn't run Fix", async function () {
    const { init, sentEmails, calls } = setup({
      [id("down")]: {
        summary: { failed: 1, firstError: "macserver unreachable" },
      },
      [id("partial")]: {
        summary: { downloaded: 2, failed: 3, firstError: "Download timed out" },
      },
    });

    await init.validateAllBlogs();

    expect(calls.walked.length).toEqual(2);
    expect(calls.fixed).toEqual([]);
    expect(sentEmails.length).toEqual(1);

    const records = byID(sentEmails[0]);
    expect(records[id("down")].hasChanges).toEqual(false);
    expect(records[id("down")].errors.length).toEqual(1);
    expect(records[id("down")].errors[0].phase).toEqual("walk");
    expect(records[id("down")].errors[0].message).toContain("macserver unreachable");
    // What the walk did before it failed is still reported
    expect(records[id("partial")].changeCount).toEqual(2);
    expect(records[id("partial")].errors[0].message).toContain(
      "3 file(s) failed to sync"
    );
  });

  it("runs Fix after a successful walk and reports its repairs and errors", async function () {
    const { init, sentEmails, calls } = setup({
      [id("repaired")]: { fixReport: { "tag-ghosts": ["a", "b"] } },
      [id("fixError")]: { fixError: new Error("fix exploded") },
      [id("partial")]: {
        fixError: new Error("fix stopped"),
        fixReport: { "entry-ghosts": ["c"] },
      },
      [id("clean")]: {},
    });

    spyOn(console, "error");
    await init.validateAllBlogs();

    expect(calls.fixed.length).toEqual(4);
    expect(sentEmails.length).toEqual(1);

    const records = byID(sentEmails[0]);
    expect(Object.keys(records).sort()).toEqual(
      [id("repaired"), id("fixError"), id("partial")].sort()
    );
    expect(records[id("repaired")].checks[0].name).toEqual("tag-ghosts");
    expect(records[id("repaired")].checks[0].count).toEqual(2);
    expect(records[id("fixError")].errors).toEqual([
      { phase: "fix", message: "fix exploded" },
    ]);
    // Fix can fail part way and still return what it repaired first
    expect(records[id("partial")].checks[0].name).toEqual("entry-ghosts");
    expect(records[id("partial")].errors[0].phase).toEqual("fix");
  });

  it("puts every kind of problem for different blogs in the same email", async function () {
    const { init, sentEmails } = setup({
      [id("changes")]: { summary: { downloaded: 1 } },
      [id("repaired")]: { fixReport: { "tag-ghosts": ["a"] } },
      [id("threw")]: { walkError: new Error("boom") },
      [id("stuck")]: { busy: true, heldSince: Date.now() - 2 * HOUR },
      [id("clean")]: {},
    });

    spyOn(console, "error");
    await init.validateAllBlogs();

    expect(sentEmails.length).toEqual(1);
    expect(Object.keys(byID(sentEmails[0])).sort()).toEqual(
      [id("changes"), id("repaired"), id("threw"), id("stuck")].sort()
    );
  });

  it("doesn't start a second sweep while one is running", async function () {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const { init, calls } = setup({
      [id("slow")]: { summary: {}, gate },
    });

    // The first sweep waits inside its walk
    const first = init.runValidation();
    await new Promise((resolve) => setImmediate(resolve));
    await init.runValidation();
    release();
    await first;

    expect(calls.walked).toEqual([id("slow")]);
  });

  it("skips a disabled blog before looking at its lock", async function () {
    const { init, sentEmails, calls } = setup({
      [id("off")]: { blogDisabled: true, heldSince: Date.now() - 3 * HOUR },
    });

    await init.validateAllBlogs();

    expect(calls.walked).toEqual([]);
    expect(sentEmails.length).toEqual(0);
  });

  describe("what the user is free to do", function () {
    const health = require("clients/health");

    it("skips and never reports a blog whose folder was deleted or storage is full, even with a stuck lock", async function () {
      const { init, sentEmails, calls } = setup({
        [id("deleted")]: {
          account: { error: "Blog directory deleted", errorCode: "SOURCE_MISSING" },
          heldSince: Date.now() - 3 * HOUR,
        },
        [id("full")]: {
          health: health.error([{ code: health.CODES.QUOTA_EXCEEDED }]),
          heldSince: Date.now() - 3 * HOUR,
          summary: { downloaded: 1 },
        },
        [id("revoked")]: {
          health: health.error([{ code: health.CODES.REAUTH_REQUIRED }]),
          summary: { failed: 1, firstError: "401" },
        },
      });

      await init.validateAllBlogs();

      expect(calls.walked).toEqual([]);
      expect(calls.fixed).toEqual([]);
      expect(sentEmails.length).toEqual(0);
    });

    it("drops a blog whose folder is deleted during the walk", async function () {
      const { init, sentEmails, calls } = setup({
        [id("vanished")]: {
          summary: { failed: 1, firstError: "folder not found" },
          // fine when the sweep starts, SOURCE_MISSING by the time it sends
          health: (reads) =>
            reads === 1
              ? health.ok()
              : health.error([{ code: health.CODES.SOURCE_MISSING }]),
        },
        [id("changes")]: { summary: { downloaded: 1 } },
      });

      await init.validateAllBlogs();

      expect(calls.walked.length).toEqual(2);
      expect(sentEmails.length).toEqual(1);
      expect(Object.keys(byID(sentEmails[0]))).toEqual([id("changes")]);
    });

    it("still reports a blog when its health can't be read", async function () {
      const { init, sentEmails, calls } = setup({
        [id("unknown")]: {
          walkError: new Error("walk exploded"),
          health: new Error("redis hiccup"),
        },
      });

      spyOn(console, "error");
      await init.validateAllBlogs();

      expect(calls.walked).toEqual([id("unknown")]);
      expect(sentEmails.length).toEqual(1);
      expect(byID(sentEmails[0])[id("unknown")].errors[0].phase).toEqual("walk");
    });
  });

  describe("stuck locks", function () {
    it("finds one on a blog the macserver hasn't pushed to in hours", async function () {
      const { init, sentEmails, calls } = setup({
        [id("quiet")]: {
          account: { lastSync: Date.now() - 6 * HOUR },
          heldSince: Date.now() - 5 * HOUR,
        },
      });

      await init.validateAllBlogs();

      expect(calls.walked).toEqual([]);
      expect(sentEmails.length).toEqual(1);
      expect(byID(sentEmails[0])[id("quiet")].hasStuckLock).toEqual(true);
    });

    it("finds one on a blog with a stored error that isn't the user's doing", async function () {
      const { init, sentEmails, calls } = setup({
        [id("broken")]: {
          account: { error: "Something went wrong", errorCode: "SYNC_ERROR" },
          heldSince: Date.now() - 3 * HOUR,
        },
      });

      await init.validateAllBlogs();

      expect(calls.walked).toEqual([]);
      expect(byID(sentEmails[0])[id("broken")].hasStuckLock).toEqual(true);
    });
  });

  it("emails an ongoing problem once, and again after it clears and returns", async function () {
    const behaviors = {
      [id("threw")]: { walkError: new Error("boom") },
      [id("stuck")]: { heldSince: Date.now() - 3 * HOUR },
      [id("changes")]: { summary: { downloaded: 1 } },
    };
    const sentEmails = [];
    const calls = { walked: [], fixed: [], locked: [] };

    spyOn(console, "error");
    const init = load(behaviors, sentEmails, calls);

    await init.validateAllBlogs();
    expect(Object.keys(byID(sentEmails[0])).sort()).toEqual(
      [id("threw"), id("stuck"), id("changes")].sort()
    );

    // The error and the stuck lock continue; a missed change is an event
    await init.validateAllBlogs();
    expect(sentEmails.length).toEqual(2);
    expect(Object.keys(byID(sentEmails[1]))).toEqual([id("changes")]);

    delete behaviors[id("threw")].walkError;
    delete behaviors[id("stuck")].heldSince;
    delete behaviors[id("changes")].summary;
    await init.validateAllBlogs();
    expect(sentEmails.length).toEqual(2);

    behaviors[id("threw")].walkError = new Error("boom");
    behaviors[id("stuck")].heldSince = Date.now() - 3 * HOUR;
    await init.validateAllBlogs();
    expect(sentEmails.length).toEqual(3);
    expect(Object.keys(byID(sentEmails[2])).sort()).toEqual(
      [id("threw"), id("stuck")].sort()
    );
  });
});
