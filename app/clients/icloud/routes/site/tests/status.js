const statusPath = require.resolve("../status");
const databasePath = require.resolve("../../../database");
const fromiCloudPath = require.resolve("../../../sync/fromiCloud");
const initialTransferPath = require.resolve("../../../sync/initialTransfer");
const establishSyncLockPath = require.resolve("sync/establishSyncLock");
const emailPath = require.resolve("helper/email");

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

  let emails, syncs;

  beforeEach(function () {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date());

    emails = [];
    syncs = [];

    // Reload status.js so it picks up the mocks and starts with empty state
    delete require.cache[statusPath];

    mockModule(databasePath, { store: async () => {} });
    mockModule(initialTransferPath, async () => {});
    mockModule(fromiCloudPath, async (blogID) => {
      syncs.push(blogID);
    });
    mockModule(establishSyncLockPath, async () => ({
      folder: { status: Object.assign(() => {}, { bind: () => () => {} }), update() {} },
      done: async () => {},
    }));
    mockModule(emailPath, {
      ICLOUD_RESYNC_REQUESTED: (_, locals) => emails.push(locals.blogID),
    });
  });

  afterEach(function () {
    jasmine.clock().uninstall();
    restoreModules();
  });

  const requestResync = async (status, blogID) =>
    status(
      { header: () => blogID, body: { resyncRequested: true } },
      fakeRes()
    );

  it("syncs on every resync request but emails once per blog per hour", async function () {
    const status = require(statusPath);

    await requestResync(status, "blog_a");
    // Past the 10s per-blog dedup window, so the resync runs again...
    jasmine.clock().tick(11 * 1000);
    await requestResync(status, "blog_a");
    jasmine.clock().tick(11 * 1000);
    await requestResync(status, "blog_a");

    expect(syncs).toEqual(["blog_a", "blog_a", "blog_a"]);
    // ...but only the first sends the admin email
    expect(emails).toEqual(["blog_a"]);

    // A different blog is capped separately
    await requestResync(status, "blog_b");
    expect(emails).toEqual(["blog_a", "blog_b"]);

    // After an hour the blog can email again
    jasmine.clock().tick(60 * 60 * 1000);
    await requestResync(status, "blog_a");
    expect(emails).toEqual(["blog_a", "blog_b", "blog_a"]);
    expect(syncs.length).toBe(5);
  });

  it("keeps a resync request retryable when the sync lock was busy", async function () {
    let lockAttempts = 0;
    const lock = {
      folder: { status: Object.assign(() => {}, { bind: () => () => {} }), update() {} },
      done: async () => {},
    };

    // Busy for the first request, free for the retry
    mockModule(establishSyncLockPath, async () => {
      lockAttempts += 1;
      if (lockAttempts === 1) throw new Error("Failed to acquire folder lock");
      return lock;
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
