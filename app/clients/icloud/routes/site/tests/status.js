const statusPath = require.resolve("../status");
const databasePath = require.resolve("../../../database");
const fromiCloudPath = require.resolve("../../../sync/fromiCloud");
const initialTransferPath = require.resolve("../../../sync/initialTransfer");
const establishSyncLockPath = require.resolve("sync/establishSyncLock");
const emailPath = require.resolve("helper/email");
const blogPath = require.resolve("models/blog");
const entriesPath = require.resolve("models/entries");
const fixPath = require.resolve("sync/fix");
const getHealthPath = require.resolve("../../../getHealth");
const validateBlogPath = require.resolve("../../../sync/validateBlog");

describe("icloud status route", function () {
  const originals = new Map();

  const mockModule = (modulePath, exportsValue) => {
    if (!originals.has(modulePath)) {
      const cached = require.cache[modulePath];
      originals.set(modulePath, cached ? cached.exports : undefined);
    }

    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: exportsValue,
    };
  };

  const restoreModules = () => {
    for (const [modulePath, exportsValue] of originals.entries()) {
      if (typeof exportsValue === "undefined") {
        delete require.cache[modulePath];
      } else {
        require.cache[modulePath] = {
          id: modulePath,
          filename: modulePath,
          loaded: true,
          exports: exportsValue,
        };
      }
    }

    originals.clear();
    delete require.cache[statusPath];
    delete require.cache[validateBlogPath];
  };

  const fakeRes = () => ({
    headersSent: false,
    send() {
      this.headersSent = true;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    set() {
      return this;
    },
  });

  let emails, syncs, fixes, stored, releases, events, blog;

  // A lock like establishSyncLock's, counting how often it is released
  const makeLock = () => ({
    folder: {
      status: Object.assign(
        (line) => events.push("status: " + line),
        { bind: () => (line) => events.push("status: " + line) }
      ),
      update() {},
    },
    done: async () => {
      releases.count += 1;
      events.push("released");
    },
  });

  beforeEach(function () {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date());

    emails = [];
    syncs = [];
    fixes = [];
    stored = [];
    releases = { count: 0 };
    events = [];
    blog = { id: "blog_a", handle: "a", client: "icloud" };

    // Reload status.js (and the validation it shares with the hourly sweep)
    // so they pick up the mocks and start with empty state
    delete require.cache[statusPath];
    delete require.cache[validateBlogPath];

    mockModule(databasePath, {
      store: async (blogID, status) => {
        stored.push(status);
      },
      stampLastSync: async () => {},
      get: async () => ({
        sharingLink: "https://www.icloud.com/iclouddrive/x",
        setupComplete: true,
      }),
    });
    mockModule(initialTransferPath, async () => {});
    // What the walk found; each test can change it
    mockModule(fromiCloudPath, async (blogID) => {
      syncs.push(blogID);
      events.push("walk");
      return { downloaded: 1 };
    });
    mockModule(establishSyncLockPath, async () => makeLock());
    mockModule(blogPath, {
      get: ({ id }, callback) =>
        callback(null, blog && Object.assign({}, blog, { id })),
    });
    mockModule(entriesPath, { getAllTotal: (_id, callback) => callback(null, 3) });
    mockModule(fixPath, (blog, callback) => {
      fixes.push(blog.id);
      events.push("fix");
      callback(null, {});
    });
    mockModule(getHealthPath, async () => ({ issues: [] }));
    mockModule(emailPath, {
      ICLOUD_RESYNC_ISSUE: (_, locals, callback) => {
        emails.push(locals);
        callback();
      },
    });
  });

  afterEach(function () {
    jasmine.clock().uninstall();
    restoreModules();
  });

  const requestResync = async (status, blogID, body = {}) =>
    status(
      {
        header: () => blogID,
        body: Object.assign({ resyncRequested: true }, body),
      },
      fakeRes()
    );

  const mockWalk = (walk) =>
    mockModule(fromiCloudPath, async (blogID) => {
      syncs.push(blogID);
      events.push("walk");
      return walk(blogID);
    });

  it("syncs on every resync request but emails once per blog per hour", async function () {
    const status = require(statusPath);
    const emailed = () => emails.map((locals) => locals.blogs[0].id);

    await requestResync(status, "blog_a");
    // Past the 10s per-blog dedup window, so the resync runs again...
    jasmine.clock().tick(11 * 1000);
    await requestResync(status, "blog_a");
    jasmine.clock().tick(11 * 1000);
    await requestResync(status, "blog_a");

    expect(syncs).toEqual(["blog_a", "blog_a", "blog_a"]);
    // ...but only the first sends the admin email
    expect(emailed()).toEqual(["blog_a"]);

    // A different blog is capped separately
    await requestResync(status, "blog_b");
    expect(emailed()).toEqual(["blog_a", "blog_b"]);

    // After an hour the blog can email again
    jasmine.clock().tick(60 * 60 * 1000);
    await requestResync(status, "blog_a");
    expect(emailed()).toEqual(["blog_a", "blog_b", "blog_a"]);
    expect(syncs.length).toBe(5);
  });

  it("emails what the resync found, with the macserver's reason", async function () {
    mockWalk(async () => ({ downloaded: 2, removed: 1 }));
    const status = require(statusPath);

    await requestResync(status, "blog_a", {
      reason: "upload for Posts/x.md failed after retries",
    });

    expect(emails.length).toBe(1);
    expect(emails[0].reason).toBe("upload for Posts/x.md failed after retries");
    expect(emails[0].blogs.length).toBe(1);
    expect(emails[0].blogs[0].changeCount).toBe(3);
    expect(emails[0].blogs[0].downloaded).toBe(2);
  });

  it("emails without a reason from an older macserver", async function () {
    const status = require(statusPath);

    await requestResync(status, "blog_a");

    expect(emails.length).toBe(1);
    expect(emails[0].reason).toBeUndefined();
  });

  it("sends nothing when the resync found no changes and Fix() repaired nothing", async function () {
    mockWalk(async () => ({ downloaded: 0, removed: 0, createdDirs: 0 }));
    const status = require(statusPath);

    await requestResync(status, "blog_a", { reason: "r" });

    expect(syncs).toEqual(["blog_a"]);
    expect(fixes).toEqual(["blog_a"]);
    expect(emails).toEqual([]);
  });

  it("doesn't count an edit that landed during the walk as a change", async function () {
    mockWalk(async () => ({ downloaded: 1, modifiedDuringWalk: 1 }));
    const status = require(statusPath);

    await requestResync(status, "blog_a");

    expect(emails).toEqual([]);
  });

  it("emails when Fix() repaired something", async function () {
    mockWalk(async () => ({}));
    mockModule(fixPath, (blog, callback) => callback(null, { "tag-ghosts": ["a"] }));
    const status = require(statusPath);

    await requestResync(status, "blog_a");

    expect(emails.length).toBe(1);
    expect(emails[0].blogs[0].checks[0].name).toBe("tag-ghosts");
  });

  it("records a failed walk in the email instead of throwing, and skips Fix()", async function () {
    mockWalk(async () => {
      throw new Error("walk exploded");
    });
    spyOn(console, "error");
    const status = require(statusPath);
    const res = fakeRes();

    await status(
      { header: () => "blog_a", body: { resyncRequested: true } },
      res
    );

    // The response had already gone out
    expect(res.statusCode).toBeUndefined();
    expect(fixes).toEqual([]);
    expect(emails.length).toBe(1);
    expect(emails[0].blogs[0].errors).toEqual([
      { phase: "walk", message: "walk exploded" },
    ]);
    expect(releases.count).toBe(1);
  });

  it("emails when Fix() failed", async function () {
    mockWalk(async () => ({}));
    mockModule(fixPath, (blog, callback) => callback(new Error("fix exploded"), {}));
    spyOn(console, "error");
    const status = require(statusPath);

    await requestResync(status, "blog_a");

    expect(emails[0].blogs[0].errors).toEqual([
      { phase: "fix", message: "fix exploded" },
    ]);
    expect(releases.count).toBe(1);
  });

  it("releases the lock exactly once, after the walk and before Fix()", async function () {
    const status = require(statusPath);

    await requestResync(status, "blog_a");

    expect(releases.count).toBe(1);
    expect(
      events.filter((event) => ["walk", "released", "fix"].includes(event))
    ).toEqual(["walk", "released", "fix"]);
  });

  it("keeps showing progress on the dashboard", async function () {
    const status = require(statusPath);

    await requestResync(status, "blog_a");

    expect(events[0]).toBe("status: Resync requested");
    expect(events[events.length - 1]).toBe("status: Resync complete");
  });

  it("doesn't store the reason on the account", async function () {
    const status = require(statusPath);

    await requestResync(status, "blog_a", { reason: "mkdir failed" });

    expect(stored).toEqual([{ resyncRequested: true }]);
  });

  it("walks with the lock's update function", async function () {
    let args;
    mockModule(fromiCloudPath, async (...received) => {
      args = received;
      return {};
    });
    const lock = makeLock();
    mockModule(establishSyncLockPath, async () => lock);
    const status = require(statusPath);

    await requestResync(status, "blog_a");

    expect(args[0]).toBe("blog_a");
    expect(args[2]).toBe(lock.folder.update);
  });

  it("keeps the resync in flight until Fix() has finished", async function () {
    let finishFix;
    mockModule(fixPath, (blog, callback) => {
      fixes.push(blog.id);
      finishFix = () => callback(null, {});
    });
    const status = require(statusPath);

    const first = requestResync(status, "blog_a");
    while (!finishFix) await Promise.resolve();

    // A second request arrives while Fix() is still running: deduplicated
    await requestResync(status, "blog_a");
    expect(syncs).toEqual(["blog_a"]);

    finishFix();
    await first;
    expect(releases.count).toBe(1);
  });

  it("releases the lock and skips when the blog is disabled or not on iCloud", async function () {
    const status = require(statusPath);

    blog = { id: "blog_a", handle: "a", client: "icloud", isDisabled: true };
    await requestResync(status, "blog_a");
    jasmine.clock().tick(11 * 1000);
    blog = { id: "blog_a", handle: "a", client: "dropbox" };
    await requestResync(status, "blog_a");
    jasmine.clock().tick(11 * 1000);
    blog = null;
    await requestResync(status, "blog_a");

    expect(syncs).toEqual([]);
    expect(fixes).toEqual([]);
    expect(emails).toEqual([]);
    expect(releases.count).toBe(3);
  });

  it("skips the resync if the blog was disconnected while it waited for the lock", async function () {
    // loadAccount passed, then the disconnect deleted the account before
    // the lock came free
    mockModule(databasePath, { store: async () => {}, get: async () => null });
    const status = require(statusPath);

    const res = fakeRes();
    await status(
      { header: () => "blog_a", body: { resyncRequested: true } },
      res
    );

    expect(res.statusCode).toBe(400);
    expect(syncs).toEqual([]);
    expect(fixes).toEqual([]);
    expect(emails).toEqual([]);
    expect(releases.count).toBe(1);
  });

  it("skips the resync if the blog was reconnected but its setup isn't complete", async function () {
    // Disconnected and reconnected while the request waited for the lock:
    // the new account's initial transfer hasn't finished
    mockModule(databasePath, {
      store: async () => {},
      get: async () => ({
        sharingLink: "https://www.icloud.com/iclouddrive/x",
        setupComplete: false,
        transferringToiCloud: true,
      }),
    });
    const status = require(statusPath);

    const res = fakeRes();
    await status(
      { header: () => "blog_a", body: { resyncRequested: true } },
      res
    );

    expect(res.statusCode).toBe(409);
    expect(syncs).toEqual([]);
    expect(emails).toEqual([]);
    expect(releases.count).toBe(1);
  });

  it("keeps a resync request retryable when setup wasn't complete", async function () {
    let setupComplete = false;
    mockModule(databasePath, {
      store: async () => {},
      stampLastSync: async () => {},
      get: async () => ({
        sharingLink: "https://www.icloud.com/iclouddrive/x",
        setupComplete,
      }),
    });
    const status = require(statusPath);

    const first = fakeRes();
    await status(
      { header: () => "blog_a", body: { resyncRequested: true } },
      first
    );
    expect(first.statusCode).toBe(409);

    // The macserver retries straight away, well inside the 10s window, and
    // setup has finished meanwhile. The retry must resync, not be
    // acknowledged by a cooldown.
    setupComplete = true;
    const retry = fakeRes();
    await status(
      { header: () => "blog_a", body: { resyncRequested: true } },
      retry
    );

    expect(retry.statusCode).toBeUndefined();
    expect(syncs).toEqual(["blog_a"]);
  });

  it("keeps a resync request retryable when the sync lock was busy", async function () {
    let lockAttempts = 0;

    // Busy for the first request, free for the retry
    mockModule(establishSyncLockPath, async () => {
      lockAttempts += 1;
      if (lockAttempts === 1) throw new Error("Failed to acquire folder lock");
      return makeLock();
    });
    const status = require(statusPath);

    const first = fakeRes();
    await status(
      { header: () => "blog_a", body: { resyncRequested: true } },
      first
    );
    expect(first.statusCode).toBe(423);

    // The macserver retries straight away, well inside the 10s window. It
    // must reach the lock again rather than be acknowledged without a resync.
    const retry = fakeRes();
    await status(
      { header: () => "blog_a", body: { resyncRequested: true } },
      retry
    );

    expect(lockAttempts).toBe(2);
    expect(retry.statusCode).toBeUndefined();
    expect(syncs).toEqual(["blog_a"]);
  });
});
