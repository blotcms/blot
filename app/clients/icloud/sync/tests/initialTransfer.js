const initialTransferPath = require.resolve("../initialTransfer");
const databasePath = require.resolve("../../database");
const toiCloudPath = require.resolve("../toiCloud");
const fromiCloudPath = require.resolve("../fromiCloud");
const resolveCaseConflictsPath = require.resolve("../resolveCaseConflicts");
const establishSyncLockPath = require.resolve("sync/establishSyncLock");
const fetchPath = require.resolve(
  "../../util/rateLimitedFetchWithRetriesAndTimeout"
);

describe("icloud initialTransfer", function () {
  const originals = new Map();
  let store;
  let done;

  function mockModule(modulePath, exportsValue) {
    if (!originals.has(modulePath)) originals.set(modulePath, require.cache[modulePath]);
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
