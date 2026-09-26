describe("dropbox sync/index skips a blog with an incomplete transfer", function () {
  // "../sync" is this client's sync/index.js (webhook-driven delta sync).
  // "sync" (bare specifier) is the app-wide folder lock module it acquires
  // before doing anything - see app/sync/index.js.
  const syncPath = require.resolve("../sync");
  const lockPath = require.resolve("sync");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");

  const blogID = "blog_synctransferincomplete" + Date.now();
  const originals = {};
  let saved;

  beforeEach(function () {
    saved = [];
    [syncPath, lockPath, createClientPath, databasePath].forEach(
      (path) => (originals[path] = require.cache[path])
    );
  });

  afterEach(function () {
    [lockPath, createClientPath, databasePath].forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
    delete require.cache[syncPath];
    if (originals[syncPath]) require.cache[syncPath] = originals[syncPath];
  });

  function load(account) {
    require.cache[lockPath] = {
      exports: function (_blogID, callback) {
        callback(
          null,
          {
            log: function () {},
            status: function () {},
            path: "/tmp/" + blogID,
          },
          function (err, cb) {
            cb(err);
          }
        );
      },
    };
    require.cache[createClientPath] = {
      exports: function (_blogID, callback) {
        // A client whose methods all immediately reject - if the skip check
        // didn't fire, this is how we'd know delta/apply actually ran (via
        // the error_code it would then persist). delta.js (delta.js:278-300)
        // calls filesListFolderContinue when the account has a cursor (as
        // all these test accounts do) rather than filesListFolder, and
        // filesGetMetadata too when folder_id is set - stub all three so the
        // "does not skip" positive control fails the same way regardless of
        // which one delta.js happens to call first.
        // Status 409 so util/retry.js (which wraps delta.js's get()) fails
        // fast instead of retrying up to 6 times with backoff.
        const reject = () =>
          Promise.reject(Object.assign(new Error("boom"), { status: 409 }));
        const client = {
          filesListFolder: reject,
          filesListFolderContinue: reject,
          filesGetMetadata: reject,
        };
        callback(null, client, account);
      },
    };
    require.cache[databasePath] = {
      exports: {
        set: function (_blogID, values, callback) {
          saved.push(values);
          callback(null);
        },
      },
    };
    delete require.cache[syncPath];
    return require("../sync");
  }

  it("skips delta/apply and never touches error_code or cursor (transfer_pending)", function (done) {
    const sync = load({
      folder_id: "",
      cursor: "old-cursor",
      error_code: 0,
      transfer_pending: true,
    });

    sync({ id: blogID }, function (err) {
      expect(err).toBeFalsy();
      expect(
        saved.every(
          (values) => !("error_code" in values) && !("cursor" in values)
        )
      ).toEqual(true);
      done();
    });
  });

  it("skips delta/apply for the legacy out-of-space error code too", function (done) {
    const sync = load({
      folder_id: "",
      cursor: "old-cursor",
      error_code: 507,
    });

    sync({ id: blogID }, function (err) {
      expect(err).toBeFalsy();
      expect(
        saved.every(
          (values) => !("error_code" in values) && !("cursor" in values)
        )
      ).toEqual(true);
      done();
    });
  });

  it("does not skip a blog whose transfer has completed", function (done) {
    const sync = load({
      folder_id: "",
      cursor: "old-cursor",
      error_code: 0,
      transfer_pending: false,
    });

    // The stubbed client's filesListFolder rejects as soon as delta calls
    // it, which persists an error_code - proof the skip check did NOT
    // trigger and delta/apply actually ran.
    sync({ id: blogID }, function () {
      expect(saved.some((values) => "error_code" in values)).toEqual(true);
      done();
    });
  });
});
