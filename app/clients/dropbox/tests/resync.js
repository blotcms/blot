describe("dropbox resync (manual 'Resync from Dropbox' dashboard action)", function () {
  const resyncPath = require.resolve("../resync");
  const databasePath = require.resolve("../database");
  const resetToBlotPath = require.resolve("../sync/reset-to-blot");

  const blogID = "blog_manualresynctest" + Date.now();
  const originals = {};

  beforeEach(function () {
    [resyncPath, databasePath, resetToBlotPath].forEach(
      (path) => (originals[path] = require.cache[path])
    );
  });

  afterEach(function () {
    [databasePath, resetToBlotPath].forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
    delete require.cache[resyncPath];
    if (originals[resyncPath]) require.cache[resyncPath] = originals[resyncPath];
  });

  function load(account, resetToBlotBehavior) {
    require.cache[databasePath] = {
      exports: {
        get: function (_blogID, callback) {
          callback(null, account);
        },
      },
    };
    require.cache[resetToBlotPath] = {
      exports: resetToBlotBehavior,
    };
    delete require.cache[resyncPath];
    return require("../resync");
  }

  it("refuses and publishes a clear message instead of calling resetToBlot, for transfer_pending", async function () {
    let resetToBlotCalled = false;
    const resync = load(
      { error_code: 0, transfer_pending: true },
      function () {
        resetToBlotCalled = true;
        return Promise.resolve();
      }
    );

    const published = [];
    let error;
    try {
      await resync(blogID, (message) => published.push(message), () => {});
    } catch (err) {
      error = err;
    }

    expect(resetToBlotCalled).toEqual(false);
    expect(error).toBeDefined();
    expect(error.code).toEqual("DROPBOX_TRANSFER_INCOMPLETE");
    expect(published.length).toEqual(1);
    expect(published[0]).toMatch(/hasn't finished transferring/);
  });

  it("refuses for the legacy out-of-space error code too", async function () {
    let resetToBlotCalled = false;
    const resync = load({ error_code: 507 }, function () {
      resetToBlotCalled = true;
      return Promise.resolve();
    });

    let error;
    try {
      await resync(blogID, () => {}, () => {});
    } catch (err) {
      error = err;
    }

    expect(resetToBlotCalled).toEqual(false);
    expect(error).toBeDefined();
  });

  it("calls resetToBlot for a blog with a completed transfer", async function () {
    let resetToBlotArgs;
    const resync = load(
      { error_code: 0, transfer_pending: false },
      function (blogID, publish, update) {
        resetToBlotArgs = [blogID, publish, update];
        return Promise.resolve({ downloaded: 0 });
      }
    );

    const publish = () => {};
    const update = () => {};
    const result = await resync(blogID, publish, update);

    expect(resetToBlotArgs[0]).toEqual(blogID);
    expect(resetToBlotArgs[1]).toEqual(publish);
    expect(resetToBlotArgs[2]).toEqual(update);
    expect(result).toEqual({ downloaded: 0 });
  });
});
