const initialTransferPath = require.resolve("../initialTransfer");
const databasePath = require.resolve("../../database");
const toiCloudPath = require.resolve("../toiCloud");
const fromiCloudPath = require.resolve("../fromiCloud");
const resolveCaseConflictsPath =
  require.resolve("../../../util/resolveCaseConflicts");
const establishSyncLockPath = require.resolve("sync/establishSyncLock");
const fetchPath =
  require.resolve("../../util/rateLimitedFetchWithRetriesAndTimeout");

describe("icloud initialTransfer", function () {
  const originals = new Map();
  let store;
  let connected;
  let controller;
  let done;

  function mockModule(modulePath, exportsValue) {
    if (!originals.has(modulePath))
      originals.set(modulePath, require.cache[modulePath]);
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: exportsValue,
    };
  }

  function load({ syncToiCloud, lock, fetch }) {
    mockModule(databasePath, {
      store,
      get: async () => (connected ? { sharingLink: "link" } : null),
    });
    mockModule(toiCloudPath, syncToiCloud);
    mockModule(fromiCloudPath, async () => {});
    mockModule(resolveCaseConflictsPath, async () => {});
    mockModule(fetchPath, fetch || (async () => {}));
    mockModule(
      establishSyncLockPath,
      lock ||
        (async () => ({
          folder: {
            status: () => {},
            update: () => {},
            signal: controller.signal,
            run: (fn) => fn(),
          },
          done,
        }))
    );
    delete require.cache[initialTransferPath];
    return require(initialTransferPath);
  }

  beforeEach(function () {
    store = jasmine.createSpy("store").and.returnValue(Promise.resolve());
    connected = true;
    controller = new AbortController();
    done = jasmine.createSpy("done").and.returnValue(Promise.resolve());
  });

  afterEach(function () {
    originals.forEach(function (cached, modulePath) {
      if (cached) require.cache[modulePath] = cached;
      else delete require.cache[modulePath];
    });
    originals.clear();
    delete require.cache[initialTransferPath];
  });

  it("clears the error and completes setup on success", async function () {
    const initialTransfer = load({ syncToiCloud: async () => {} });

    await initialTransfer("blog");

    expect(store).toHaveBeenCalledWith("blog", {
      transferringToiCloud: true,
      error: null,
    });
    expect(store).toHaveBeenCalledWith("blog", {
      setupComplete: true,
      transferringToiCloud: false,
      error: null,
    });
  });

  it("marks the transfer as due before taking the lock, and leaves it due when the lock is busy", async function () {
    const order = [];
    store.and.callFake(async (blogID, data) => {
      order.push(["store", data]);
    });
    const initialTransfer = load({
      syncToiCloud: async () => {},
      lock: async () => {
        order.push(["lock"]);
        throw new Error("Failed to acquire folder lock");
      },
    });

    let thrown;
    try {
      await initialTransfer("blog");
    } catch (err) {
      thrown = err;
    }

    expect(thrown && thrown.message).toBe("Failed to acquire folder lock");
    // Only the mark: nothing clears it, so resumeTransfers finds the blog
    expect(order).toEqual([
      ["store", { transferringToiCloud: true, error: null }],
      ["lock"],
    ]);
  });

  it("asks the macserver to watch the folder with retries spaced out", async function () {
    const fetch = jasmine.createSpy("fetch").and.returnValue(Promise.resolve());
    const initialTransfer = load({ syncToiCloud: async () => {}, fetch });

    await initialTransfer("blog", { watchRetryDelayMs: 5 });

    expect(fetch).toHaveBeenCalledWith(
      jasmine.stringMatching(/\/watch$/),
      jasmine.objectContaining({ retries: 5, retryDelay: 5 })
    );
  });

  it("reruns the verify pass after a failed listing", async function () {
    let calls = 0;
    const initialTransfer = load({
      syncToiCloud: async () => {
        calls++;
        // second call is the first verify pass
        if (calls === 2) throw new Error("ls stalled");
      },
    });

    await initialTransfer("blog", { verifyRetryDelayMs: 0 });

    expect(calls).toBe(3);
    expect(store).toHaveBeenCalledWith("blog", {
      setupComplete: true,
      transferringToiCloud: false,
      error: null,
    });
  });

  it("gives up with TRANSFER_INCOMPLETE once verify retries are exhausted", async function () {
    let calls = 0;
    const initialTransfer = load({
      syncToiCloud: async () => {
        calls++;
        if (calls > 1) throw new Error("ls stalled");
      },
    });

    let thrown;
    try {
      await initialTransfer("blog", { verifyRetryDelayMs: 0 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown && thrown.message).toBe("ls stalled");
    expect(calls).toBe(4);
    expect(store).toHaveBeenCalledWith("blog", {
      transferringToiCloud: false,
      error: "ls stalled",
      errorCode: "TRANSFER_INCOMPLETE",
    });
  });

  it("records a failed transfer as TRANSFER_INCOMPLETE and releases the lock", async function () {
    const initialTransfer = load({
      syncToiCloud: async () => {
        throw new Error("upload failed");
      },
    });

    let thrown;
    try {
      await initialTransfer("blog");
    } catch (err) {
      thrown = err;
    }

    expect(thrown && thrown.message).toBe("upload failed");
    expect(store).toHaveBeenCalledWith("blog", {
      transferringToiCloud: false,
      error: "upload failed",
      errorCode: "TRANSFER_INCOMPLETE",
    });
    expect(store).not.toHaveBeenCalledWith(
      "blog",
      jasmine.objectContaining({ setupComplete: true })
    );
    expect(done).toHaveBeenCalled();
  });

  it("stops for a disconnect without writing the account or watching the folder", async function () {
    const fetch = jasmine.createSpy("fetch").and.returnValue(Promise.resolve());
    const cancelled = Object.assign(new Error("Sync cancelled"), {
      code: "ECANCELED",
      reason: "disconnect",
    });
    let walkSignal;
    const initialTransfer = load({
      fetch,
      syncToiCloud: async (blogID, status, update, options) => {
        walkSignal = options.signal;
        // seize() stops the transfer part way through the copy
        controller.abort(cancelled);
        throw cancelled;
      },
    });

    let thrown;
    try {
      await initialTransfer("blog");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(cancelled);
    expect(walkSignal).toBe(controller.signal);
    // Only the mark made before the lock: nothing after the abort
    expect(store.calls.allArgs()).toEqual([
      ["blog", { transferringToiCloud: true, error: null }],
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });

  it("doesn't start for a blog no longer connected", async function () {
    connected = false;
    const syncToiCloud = jasmine.createSpy("syncToiCloud");
    const initialTransfer = load({ syncToiCloud });

    await expectAsync(initialTransfer("blog")).toBeRejected();

    expect(store).not.toHaveBeenCalled();
    expect(syncToiCloud).not.toHaveBeenCalled();
  });

  it("stops without copying when a disconnect finished before it took the lock", async function () {
    const syncToiCloud = jasmine.createSpy("syncToiCloud");
    const initialTransfer = load({
      syncToiCloud,
      lock: async () => {
        // The disconnect deleted the account while this waited for the lock
        connected = false;
        return {
          folder: {
            status: () => {},
            update: () => {},
            signal: controller.signal,
            run: (fn) => fn(),
          },
          done,
        };
      },
    });

    await expectAsync(initialTransfer("blog")).toBeRejected();

    expect(syncToiCloud).not.toHaveBeenCalled();
    expect(store.calls.allArgs()).toEqual([
      ["blog", { transferringToiCloud: true, error: null }],
    ]);
    expect(done).toHaveBeenCalled();
  });
});
