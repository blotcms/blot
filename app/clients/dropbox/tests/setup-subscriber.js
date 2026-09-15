describe("dropbox setup abort subscriber", function () {
  const setupPath = require.resolve("clients/dropbox/routes/setup");
  const subscriberPath = require.resolve("helper/redisSubscriber");
  const syncPath = require.resolve("sync");
  const getAccountPath = require.resolve("clients/dropbox/routes/setup/getAccount");
  const createFolderPath = require.resolve("clients/dropbox/routes/setup/createFolder");
  const resetPath = require.resolve("clients/dropbox/sync/reset-from-blot");
  const databasePath = require.resolve("clients/dropbox/database");

  const originals = {};

  function restore(path, original) {
    if (original) require.cache[path] = original;
    else delete require.cache[path];
  }

  beforeEach(function () {
    originals.subscriber = require.cache[subscriberPath];
    originals.sync = require.cache[syncPath];
    originals.getAccount = require.cache[getAccountPath];
    originals.createFolder = require.cache[createFolderPath];
    originals.reset = require.cache[resetPath];
    originals.database = require.cache[databasePath];
    originals.setup = require.cache[setupPath];
  });

  afterEach(function () {
    delete require.cache[setupPath];
    restore(subscriberPath, originals.subscriber);
    restore(syncPath, originals.sync);
    restore(getAccountPath, originals.getAccount);
    restore(createFolderPath, originals.createFolder);
    restore(resetPath, originals.reset);
    restore(databasePath, originals.database);
    restore(setupPath, originals.setup);
  });

  function loadSetup({ onMessage, cleanup, setupPromise }) {
    require.cache[subscriberPath] = {
      exports: function (options) {
        onMessage.captured = options;
        return {
          cleanup: cleanup,
          setupPromise: setupPromise || Promise.resolve(),
        };
      },
    };
    require.cache[syncPath] = {
      exports: function (_blogID, worker) {
        const folder = { status: jasmine.createSpy("status") };
        const done = jasmine.createSpy("done").and.callFake(function (err, cb) {
          if (typeof cb === "function") cb(err);
        });
        worker(null, folder, done);
        return done;
      },
    };
    require.cache[getAccountPath] = {
      exports: async function (account) {
        return account;
      },
    };
    require.cache[createFolderPath] = {
      exports: async function (account) {
        return account;
      },
    };
    require.cache[resetPath] = {
      exports: async function () {},
    };
    require.cache[databasePath] = {
      exports: {
        set: function (_id, _data, callback) {
          callback(null);
        },
      },
    };
    delete require.cache[setupPath];
    return require("clients/dropbox/routes/setup");
  }

  it("uses redisSubscriber for the abort channel and quits through cleanup", function (done) {
    const cleanup = jasmine.createSpy("cleanup").and.returnValue(Promise.resolve());
    const captured = {};
    const setup = loadSetup({ onMessage: captured, cleanup });
    const session = { dropbox: {}, save: jasmine.createSpy("save") };

    setup({ blog: { id: "blog_1" } }, session, function (err) {
      expect(err).toBeFalsy();
      expect(captured.captured.channel).toBe("sync:status:blog_1");
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(session.dropbox).toBeUndefined();
      done();
    });
  });

  it("cleans up when an abort message arrives during setup", function (done) {
    const cleanup = jasmine.createSpy("cleanup").and.returnValue(Promise.resolve());
    const captured = {};
    let releaseAccount;
    require.cache[subscriberPath] = {
      exports: function (options) {
        captured.captured = options;
        return { cleanup: cleanup, setupPromise: Promise.resolve() };
      },
    };
    require.cache[syncPath] = {
      exports: function (_blogID, worker) {
        const folder = { status: jasmine.createSpy("status") };
        const done = jasmine.createSpy("done").and.callFake(function (err, cb) {
          if (typeof cb === "function") cb(err);
        });
        worker(null, folder, done);
      },
    };
    require.cache[getAccountPath] = {
      exports: function (account) {
        return new Promise(function (resolve) {
          releaseAccount = function () {
            resolve(account);
          };
        });
      },
    };
    require.cache[createFolderPath] = {
      exports: async function (account) {
        return account;
      },
    };
    require.cache[resetPath] = { exports: async function () {} };
    require.cache[databasePath] = {
      exports: {
        set: function (_id, _data, callback) {
          callback(null);
        },
      },
    };
    delete require.cache[setupPath];
    const setup = require("clients/dropbox/routes/setup");
    const session = { dropbox: {}, save: jasmine.createSpy("save") };

    setup({ blog: { id: "blog_1" } }, session, function (err) {
      expect(err).toEqual(jasmine.any(Error));
      expect(err.message).toBe("Dropbox setup aborted");
      expect(cleanup).toHaveBeenCalledTimes(1);
      done();
    });

    Promise.resolve().then(function () {
      captured.captured.onMessage("Attempting to disconnect from Dropbox");
      releaseAccount();
    });
  });
});
