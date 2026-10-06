const resyncPath = require.resolve("../resync");
const databasePath = require.resolve("../database");
const fromiCloudPath = require.resolve("../sync/fromiCloud");

describe("icloud resync", function () {
  const originals = new Map();

  function mockModule(modulePath, exportsValue) {
    if (!originals.has(modulePath)) originals.set(modulePath, require.cache[modulePath]);
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: exportsValue,
    };
  }

  function load(account) {
    const syncFromiCloud = jasmine
      .createSpy("syncFromiCloud")
      .and.returnValue(Promise.resolve({ downloaded: 1 }));

    mockModule(databasePath, { get: async () => account });
    mockModule(fromiCloudPath, syncFromiCloud);
    // Load a fresh copy bound to the mocks; afterEach puts back whatever
    // was cached (e.g. by the client index) before this spec ran.
    if (!originals.has(resyncPath)) originals.set(resyncPath, require.cache[resyncPath]);
    delete require.cache[resyncPath];

    return { resync: require(resyncPath), syncFromiCloud };
  }

  async function rejection(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("Expected promise to reject");
  }

  afterEach(function () {
    originals.forEach(function (cached, modulePath) {
      if (cached) require.cache[modulePath] = cached;
      else delete require.cache[modulePath];
    });
    originals.clear();
  });

  it("syncs from iCloud for a set-up blog", async function () {
    const { resync, syncFromiCloud } = load({ setupComplete: true });
    const publish = () => {};
    const update = () => {};

    expect(await resync("blog", publish, update)).toEqual({ downloaded: 1 });
    expect(syncFromiCloud).toHaveBeenCalledWith("blog", publish, update);
  });

  it("refuses without syncing when the folder is missing", async function () {
    const { resync, syncFromiCloud } = load({
      setupComplete: true,
      error: "Blog directory deleted",
      errorCode: "SOURCE_MISSING",
    });

    const err = await rejection(resync("blog"));

    expect(err.code).toBe("ICLOUD_FOLDER_MISSING");
    expect(syncFromiCloud).not.toHaveBeenCalled();
  });

  it("refuses when the folder is missing on a legacy row without a code", async function () {
    const { resync } = load({
      setupComplete: true,
      error: "Blog directory deleted",
    });

    expect((await rejection(resync("blog"))).code).toBe("ICLOUD_FOLDER_MISSING");
  });

  it("refuses after a failed initial transfer so unsent local files are not removed", async function () {
    const { resync, syncFromiCloud } = load({
      setupComplete: false,
      error: "Request failed",
      errorCode: "TRANSFER_INCOMPLETE",
    });

    const err = await rejection(resync("blog"));

    expect(err.code).toBe("ICLOUD_SETUP_INCOMPLETE");
    expect(syncFromiCloud).not.toHaveBeenCalled();
  });

  it("refuses when there is no iCloud account", async function () {
    const { resync, syncFromiCloud } = load(null);

    expect((await rejection(resync("blog"))).code).toBe("ICLOUD_SETUP_INCOMPLETE");
    expect(syncFromiCloud).not.toHaveBeenCalled();
  });
});
