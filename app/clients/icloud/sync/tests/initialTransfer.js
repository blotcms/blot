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

  function load({ syncToiCloud }) {
    mockModule(databasePath, { store });
    mockModule(toiCloudPath, syncToiCloud);
    mockModule(fromiCloudPath, async () => {});
    mockModule(resolveCaseConflictsPath, async () => {});
    mockModule(fetchPath, async () => {});
    mockModule(establishSyncLockPath, async () => ({
      folder: { status: () => {}, update: () => {} },
      done,
    }));
    delete require.cache[initialTransferPath];
    return require(initialTransferPath);
  }

  beforeEach(function () {
    store = jasmine.createSpy("store").and.returnValue(Promise.resolve());
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
});
