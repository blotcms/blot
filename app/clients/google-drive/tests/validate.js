const fs = require("fs");
const vm = require("vm");
const health = require("clients/health");
const { classify } = require("../database/error");

const MINUTE = 60 * 1000;

const cachePaths = [require.resolve("sync/lock"), require.resolve("models/client")];
const originals = {};

function stubModule(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

function stubRedis(heldSince, reported) {
  stubModule(cachePaths[0], {
    heldSince: async (blogID) => heldSince[blogID] || null,
  });
  stubModule(cachePaths[1], {
    sMembers: async () => Array.from(reported),
    multi() {
      const ops = [];
      const multi = {
        del: () => (ops.push(() => reported.clear()), multi),
        sAdd: (key, ids) => (ops.push(() => ids.forEach((id) => reported.add(id))), multi),
        exec: async () => ops.forEach((op) => op()),
      };
      return multi;
    },
  });
}

// Loads validate.js with its dependencies stubbed. walks maps blogID to what
// sync.js resolves (a summary, or false) or to an Error it throws; locks maps
// blogID to the Error establishSyncLock rejects with. heldSince maps blogID
// to when its folder lock was taken, healths maps blogID to getHealth's answer
// (an Error to throw, or a function of how many times it was read); a blog
// not in it is as healthy as its stored account says. reported is the set the
// digest remembers having reported (see clients/util/syncReport).
function load({
  accounts,
  blogs,
  walks = {},
  locks = {},
  fixes = {},
  onWalk = {},
  onLock = {},
  heldSince = {},
  healths = {},
  reported = new Set(),
}) {
  const module = { exports: {} };
  const reads = {};
  const calls = {
    walked: [],
    fixed: [],
    released: [],
    emails: [],
    scheduled: [],
  };

  const stubs = {
    "node-schedule": {
      scheduleJob(cron, fn) {
        calls.scheduled.push({ cron, fn });
      },
    },
    "helper/clfdate": () => "",
    "helper/email": {
      GOOGLE_DRIVE_SYNC_ISSUE(uid, locals, callback) {
        calls.emails.push(locals);
        callback(null);
      },
    },
    "helper/eventLoopMonitor": {
      measure: () => () => ({ durationMs: 0, maxLagMs: 0, p99LagMs: 0 }),
    },
    "models/entries": {
      getAllTotal: (blogID, callback) => callback(null, 3),
    },
    "models/blog": {
      get: ({ id }, callback) => callback(null, blogs[id] || null),
    },
    "sync/establishSyncLock": async (blogID) => {
      if (locks[blogID]) throw locks[blogID];
      if (onLock[blogID]) onLock[blogID]();
      return {
        folder: { status() {}, update: async () => {} },
        done: async () => calls.released.push(blogID),
      };
    },
    "sync/fix": (blog, callback) => {
      calls.fixed.push(blog.id);
      const fix = fixes[blog.id] || {};
      callback(fix.error || null, fix.report);
    },
    "./getHealth": async (blogID) => {
      reads[blogID] = (reads[blogID] || 0) + 1;
      let result = healths[blogID];
      if (typeof result === "function") result = result(reads[blogID]);
      if (result instanceof Error) throw result;
      if (result) return result;
      const code = classify(accounts[blogID]);
      return code ? health.error([{ code }]) : health.ok();
    },
    "./database/error": require("../database/error"),
    "./database": {
      blog: {
        iterate: async (callback) => {
          for (const [blogID, account] of Object.entries(accounts)) {
            await callback(blogID, account);
          }
        },
        get: async (blogID) => accounts[blogID],
      },
    },
    "./sync/sync": async (blogID) => {
      calls.walked.push(blogID);
      if (onWalk[blogID]) onWalk[blogID]();
      const walk = walks[blogID];
      if (walk instanceof Error) throw walk;
      return walk === undefined ? { downloaded: 0, removed: 0, createdDirs: 0 } : walk;
    },
  };

  // syncReport itself is the real thing; only its Redis reads are faked
  stubRedis(heldSince, reported);

  vm.runInNewContext(fs.readFileSync(require.resolve("../validate"), "utf8"), {
    module,
    exports: module.exports,
    console: { log() {}, error() {} },
    Date,
    require: (name) =>
      Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name] : require(name),
  });

  return { validate: module.exports, calls };
}

const recent = () => Date.now() - 10 * MINUTE;

function driveAccount(overrides) {
  return Object.assign(
    {
      folderId: "folder",
      serviceAccountId: "service",
      lastSync: recent(),
    },
    overrides
  );
}

function blogsFor(...ids) {
  const blogs = {};
  for (const id of ids) {
    blogs[id] = { id, handle: "handle-" + id, client: "google-drive" };
  }
  return blogs;
}

describe("Google Drive hourly sync validation", function () {
  beforeEach(function () {
    cachePaths.forEach((path) => (originals[path] = require.cache[path]));
  });

  afterEach(function () {
    cachePaths.forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
  });

  it("schedules the sweep at :30", function () {
    const { validate, calls } = load({ accounts: {}, blogs: {} });
    validate();
    expect(calls.scheduled.length).toBe(1);
    expect(calls.scheduled[0].cron).toBe("30 * * * *");
  });

  it("emails one digest with the changes the walk found", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount(), b: driveAccount() },
      blogs: blogsFor("a", "b"),
      walks: { a: { downloaded: 2, removed: 1, createdDirs: 1, modifiedDuringWalk: 0 } },
    });

    await validate.runValidation();

    expect(calls.walked).toEqual(["a", "b"]);
    expect(calls.released).toEqual(["a", "b"]);
    expect(calls.emails.length).toBe(1);
    expect(calls.emails[0].blogs.map((b) => b.id)).toEqual(["a"]);
    expect(calls.emails[0].blogs[0]).toEqual(
      jasmine.objectContaining({
        changeCount: 4,
        downloaded: 2,
        removed: 1,
        createdDirs: 1,
      })
    );
  });

  it("does not count edits that landed mid-walk", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
      walks: { a: { downloaded: 1, removed: 0, createdDirs: 0, modifiedDuringWalk: 1 } },
    });

    await validate.runValidation();

    expect(calls.emails).toEqual([]);
  });

  it("sends no email when nothing changed or needed repair", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
    });

    await validate.runValidation();

    expect(calls.walked).toEqual(["a"]);
    expect(calls.fixed).toEqual(["a"]);
    expect(calls.emails).toEqual([]);
  });

  it("silently skips a busy blog and does not fix it", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
      locks: { a: new Error("Failed to acquire folder lock") },
      heldSince: { a: Date.now() - 5 * MINUTE },
    });

    await validate.runValidation();

    expect(calls.walked).toEqual([]);
    expect(calls.fixed).toEqual([]);
    expect(calls.emails).toEqual([]);
  });

  it("silently skips a blog that was disabled", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
      locks: { a: new Error("Cannot sync blog a") },
    });

    await validate.runValidation();

    expect(calls.emails).toEqual([]);
  });

  it("reports a failed walk as an error and does not run Fix", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
      walks: { a: false },
    });

    await validate.runValidation();

    expect(calls.fixed).toEqual([]);
    expect(calls.released).toEqual(["a"]);
    expect(calls.emails.length).toBe(1);
    expect(calls.emails[0].blogs[0].errors).toEqual([
      { phase: "walk", message: "walk failed (see logs)" },
    ]);
    expect(calls.emails[0].blogs[0].hasChanges).toBe(false);
  });

  it("reports a walk that throws, and still releases the lock", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
      walks: { a: new Error("No credentials found for service account") },
    });

    await validate.runValidation();

    expect(calls.fixed).toEqual([]);
    expect(calls.released).toEqual(["a"]);
    expect(calls.emails[0].blogs[0].errors).toEqual([
      { phase: "walk", message: "No credentials found for service account" },
    ]);
  });

  it("does not report a failed walk when the folder is gone", async function () {
    const account = driveAccount();
    const { validate, calls } = load({
      accounts: { a: account },
      blogs: blogsFor("a"),
      walks: { a: false },
      // sync.js records the lost folder on the account as it fails
      onWalk: { a: () => (account.errorCode = health.CODES.SOURCE_MISSING) },
    });

    await validate.runValidation();

    expect(calls.walked).toEqual(["a"]);
    expect(calls.fixed).toEqual([]);
    expect(calls.emails).toEqual([]);
  });

  it("reports an error from Fix, along with what it repaired first", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
      fixes: {
        a: {
          error: new Error("fix blew up"),
          report: { "tag-ghosts": ["one"] },
        },
      },
    });

    await validate.runValidation();

    const [record] = calls.emails[0].blogs;
    expect(record.errors).toEqual([{ phase: "fix", message: "fix blew up" }]);
    expect(record.checks.map((c) => c.name)).toEqual(["tag-ghosts"]);
  });

  it("reports what Fix repaired", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
      fixes: { a: { report: { "entry-ghosts": ["x", "y"] } } },
    });

    await validate.runValidation();

    const [record] = calls.emails[0].blogs;
    expect(record.hasRepairs).toBe(true);
    expect(record.checks).toEqual([
      jasmine.objectContaining({ name: "entry-ghosts", count: 2, sample: ['"x"', '"y"'] }),
    ]);
  });

  it("checks only Drive blogs with a real sync in the last hour", async function () {
    const folder = { folderId: "folder", serviceAccountId: "service" };
    const { validate, calls } = load({
      accounts: {
        recent: driveAccount(),
        stale: driveAccount({ lastSync: Date.now() - 90 * MINUTE }),
        neverSynced: { ...folder },
        switchedClient: driveAccount(),
        settingUp: driveAccount({ preparing: true }),
        noFolder: driveAccount({ folderId: null }),
        noServiceAccount: driveAccount({ serviceAccountId: undefined }),
        folderLost: driveAccount({ errorCode: health.CODES.SOURCE_MISSING }),
        missingBlog: driveAccount(),
      },
      blogs: Object.assign(blogsFor("recent", "stale", "neverSynced", "settingUp", "noFolder", "noServiceAccount", "folderLost"), {
        switchedClient: { id: "switchedClient", client: "dropbox" },
      }),
    });

    await validate.runValidation();

    expect(calls.walked).toEqual(["recent"]);
    expect(calls.fixed).toEqual(["recent"]);
  });

  it("keeps going after a blog fails", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount(), b: driveAccount() },
      blogs: blogsFor("a", "b"),
      walks: { a: new Error("boom") },
    });

    await validate.runValidation();

    expect(calls.walked).toEqual(["a", "b"]);
    expect(calls.emails[0].blogs.map((b) => b.id)).toEqual(["a"]);
  });

  it("skips a disabled blog", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: { a: { id: "a", client: "google-drive", isDisabled: true } },
    });

    await validate.runValidation();

    expect(calls.walked).toEqual([]);
  });

  it("walks nothing when setup or an error starts while waiting for the lock", async function () {
    const account = driveAccount();
    const { validate, calls } = load({
      accounts: { a: account },
      blogs: blogsFor("a"),
      onLock: { a: () => (account.preparing = true) },
    });

    await validate.runValidation();

    expect(calls.walked).toEqual([]);
    expect(calls.fixed).toEqual([]);
    expect(calls.released).toEqual(["a"]);
    expect(calls.emails).toEqual([]);
  });

  it("reports a walk that skipped files, with its changes, and does not run Fix", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
      walks: {
        a: { downloaded: 2, removed: 0, createdDirs: 0, failed: 1, firstError: "/a.jpg: boom" },
      },
    });

    await validate.runValidation();

    expect(calls.fixed).toEqual([]);
    const [record] = calls.emails[0].blogs;
    expect(record.changeCount).toBe(2);
    expect(record.errors).toEqual([
      { phase: "walk", message: "1 file(s) failed to sync, eg. /a.jpg: boom" },
    ]);
  });

  describe("what the user is free to do", function () {
    it("skips a blog with a user-side issue, without walking, fixing or reporting it", async function () {
      const accounts = {};
      const blogs = {};
      const heldSince = {};
      [
        health.CODES.REAUTH_REQUIRED,
        health.CODES.SOURCE_MISSING,
        health.CODES.QUOTA_EXCEEDED,
      ].forEach((code) => {
        accounts[code] = driveAccount({ errorCode: code });
        blogs[code] = { id: code, client: "google-drive" };
        heldSince[code] = Date.now() - 3 * 60 * MINUTE;
      });
      const { validate, calls } = load({ accounts, blogs, heldSince });

      await validate.runValidation();

      expect(calls.walked).toEqual([]);
      expect(calls.fixed).toEqual([]);
      expect(calls.emails).toEqual([]);
    });

    it("drops a blog whose folder disappears during the walk", async function () {
      const { validate, calls } = load({
        accounts: { a: driveAccount(), b: driveAccount() },
        blogs: blogsFor("a", "b"),
        walks: { a: new Error("folder gone"), b: { downloaded: 1, removed: 0, createdDirs: 0 } },
        // healthy when the sweep starts, SOURCE_MISSING by the time it sends
        healths: {
          a: (reads) =>
            reads === 1 ? health.ok() : health.error([{ code: health.CODES.SOURCE_MISSING }]),
        },
      });

      await validate.runValidation();

      expect(calls.walked).toEqual(["a", "b"]);
      expect(calls.emails[0].blogs.map((b) => b.id)).toEqual(["b"]);
    });

    it("still reports a blog when its health can't be read", async function () {
      const { validate, calls } = load({
        accounts: { a: driveAccount() },
        blogs: blogsFor("a"),
        walks: { a: new Error("boom") },
        healths: { a: new Error("redis hiccup") },
      });

      await validate.runValidation();

      expect(calls.walked).toEqual(["a"]);
      expect(calls.emails[0].blogs[0].errors[0].phase).toBe("walk");
    });
  });

  describe("stuck locks", function () {
    it("finds one on a blog with no recent sync, and does not walk it", async function () {
      const { validate, calls } = load({
        accounts: {
          stuck: driveAccount({ lastSync: Date.now() - 5 * 60 * MINUTE }),
          idle: driveAccount({ lastSync: Date.now() - 5 * 60 * MINUTE }),
        },
        blogs: blogsFor("stuck", "idle"),
        heldSince: { stuck: Date.now() - 5 * 60 * MINUTE },
      });

      await validate.runValidation();

      expect(calls.walked).toEqual([]);
      expect(calls.emails.length).toBe(1);
      expect(calls.emails[0].blogs.map((b) => b.id)).toEqual(["stuck"]);
      expect(calls.emails[0].blogs[0].hasStuckLock).toBe(true);
    });

    it("does not report a lock held for less than an hour", async function () {
      const { validate, calls } = load({
        accounts: { a: driveAccount() },
        blogs: blogsFor("a"),
        locks: { a: new Error("Failed to acquire folder lock") },
        heldSince: { a: Date.now() - 50 * MINUTE },
      });

      await validate.runValidation();

      expect(calls.emails).toEqual([]);
    });
  });

  it("emails an ongoing problem once, and again after it clears and returns", async function () {
    const reported = new Set();
    const accounts = { a: driveAccount(), b: driveAccount(), c: driveAccount() };
    const blogs = blogsFor("a", "b", "c");
    const walks = { a: new Error("boom"), c: { downloaded: 1, removed: 0, createdDirs: 0 } };
    const heldSince = { b: Date.now() - 3 * 60 * MINUTE };
    const emails = [];

    async function sweep() {
      const { validate, calls } = load({ accounts, blogs, walks, heldSince, reported });
      await validate.runValidation();
      emails.push(...calls.emails);
    }

    await sweep();
    expect(emails[0].blogs.map((b) => b.id).sort()).toEqual(["a", "b", "c"]);

    // The error and the stuck lock continue; the missed change is an event
    await sweep();
    expect(emails.length).toBe(2);
    expect(emails[1].blogs.map((b) => b.id)).toEqual(["c"]);

    delete walks.a;
    delete heldSince.b;
    await sweep();
    expect(emails.length).toBe(3);

    walks.a = new Error("boom");
    heldSince.b = Date.now() - 3 * 60 * MINUTE;
    await sweep();
    expect(emails.length).toBe(4);
    expect(emails[3].blogs.map((b) => b.id).sort()).toEqual(["a", "b", "c"]);
  });
});
