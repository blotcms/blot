const fs = require("fs");
const vm = require("vm");
const health = require("clients/health");
const realSyncReport = require("clients/util/syncReport");

const MINUTE = 60 * 1000;

// Loads validate.js with its dependencies stubbed. walks maps blogID to what
// sync.js resolves (a summary, or false) or to an Error it throws; locks maps
// blogID to the Error establishSyncLock rejects with.
function load({
  accounts,
  blogs,
  walks = {},
  locks = {},
  fixes = {},
  onWalk = {},
}) {
  const module = { exports: {} };
  const calls = {
    walked: [],
    fixed: [],
    busy: [],
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
    // recordBusy reads the lock's age from Redis; the rest is the real thing
    "clients/util/syncReport": Object.assign({}, realSyncReport, {
      recordBusy: async (report, blog) => {
        calls.busy.push(blog.id);
        return false;
      },
    }),
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

  it("skips a busy blog, asks recordBusy about it, and does not fix it", async function () {
    const { validate, calls } = load({
      accounts: { a: driveAccount() },
      blogs: blogsFor("a"),
      locks: { a: new Error("Failed to acquire folder lock") },
    });

    await validate.runValidation();

    expect(calls.busy).toEqual(["a"]);
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

    expect(calls.busy).toEqual([]);
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
});
