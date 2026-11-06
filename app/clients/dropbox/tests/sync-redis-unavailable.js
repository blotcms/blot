describe("dropbox sync when Redis is unavailable", function () {
  // Real folder lock, real sync/update, real Entry model. Only the Dropbox
  // API and the Dropbox account row are faked, so the spec can show what
  // happens to a change when the database refuses the write: the cursor stays
  // where it was, and the next sync fetches and applies the same change.
  const folder = require("storage/folder");
  const Entry = require("models/entry");
  const { SimpleError } = require("redis");
  const { isRedisUnavailableError } = require("helper/redisUnavailable");

  const syncPath = require.resolve("../sync");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");
  // persistError.js binds ../database once at load, see
  // sync-transfer-incomplete.js
  const persistErrorPath = require.resolve("../util/persistError");
  const modulePaths = [
    createClientPath,
    databasePath,
    persistErrorPath,
    syncPath,
  ];

  global.test.timeout(30 * 1000);
  global.test.blog();

  const originals = {};
  const path = "/hello.txt";
  const contents = "Hello, world";
  let store;
  let saved;
  let sync;

  beforeEach(function () {
    saved = [];
    store = {
      account: {
        folder_id: "",
        folder: "",
        cursor: "cursor-0",
        error_code: 0,
        error_source: "",
        error_since: 0,
        last_sync: 0,
        transfer_pending: false,
      },
    };

    modulePaths.forEach((p) => (originals[p] = require.cache[p]));

    // Dropbox keeps returning the change until the cursor moves past it
    const client = {
      filesListFolderContinue: function ({ cursor }) {
        const entries =
          cursor === "cursor-0"
            ? [
                {
                  ".tag": "file",
                  path_display: path,
                  name: "hello.txt",
                  size: contents.length,
                },
              ]
            : [];
        return Promise.resolve({
          result: {
            entries,
            cursor: cursor === "cursor-0" ? "cursor-1" : cursor,
            has_more: false,
          },
        });
      },
      filesListFolder: function () {
        return Promise.reject(
          new Error("the sync should continue from its cursor")
        );
      },
      filesGetMetadata: function () {
        return Promise.resolve({
          result: { path_display: path, size: contents.length },
        });
      },
      filesDownload: function () {
        return Promise.resolve({
          result: { fileBinary: Buffer.from(contents) },
        });
      },
    };

    require.cache[createClientPath] = {
      exports: function (_blogID, callback) {
        callback(null, client, Object.assign({}, store.account));
      },
    };
    require.cache[databasePath] = {
      exports: {
        set: async function (_blogID, values) {
          saved.push(Object.assign({}, values));
          Object.assign(store.account, values);
        },
        setError: async function () {},
      },
    };
    delete require.cache[persistErrorPath];
    delete require.cache[syncPath];
    sync = require("../sync");
  });

  afterEach(function () {
    modulePaths.forEach((p) => {
      if (originals[p]) require.cache[p] = originals[p];
      else delete require.cache[p];
    });
  });

  function freeze() {
    return new SimpleError("NOREPLICAS Not enough good replicas to write.");
  }

  it("leaves the cursor in place, then applies the change on the next sync", function (done) {
    const blog = this.blog;
    const checkEntry = global.test.CheckEntry(blog.id);

    spyOn(Entry, "set").and.callFake(async function () {
      throw freeze();
    });

    sync(blog, function (err) {
      expect(isRedisUnavailableError(err)).toBe(true);

      // The file made it to the folder but not into the database, and the
      // cursor was not moved past the change
      folder.read(blog.id, path).then(function (buffer) {
        expect(buffer.toString("utf-8")).toEqual(contents);
        expect(store.account.cursor).toEqual("cursor-0");
        expect(saved.some((values) => "cursor" in values)).toBe(false);

        Entry.get(blog.id, path).then(function (entry) {
          expect(entry).toBeFalsy();

          // The freeze is over
          Entry.set.and.callThrough();

          sync(blog, function (err) {
            if (err) return done.fail(err);

            expect(store.account.cursor).toEqual("cursor-1");

            checkEntry({ path: path, deleted: false }, function (err) {
              if (err) return done.fail(err);
              done();
            });
          });
        }, done.fail);
      }, done.fail);
    });
  });

  it("stamps last_sync by default, but not for a catch-up sync", function (done) {
    const blog = this.blog;

    sync(blog, function (err) {
      if (err) return done.fail(err);

      expect(store.account.last_sync).toBeGreaterThan(0);
      expect(saved.some((values) => "last_sync" in values)).toBe(true);

      store.account.last_sync = 12345;
      store.account.cursor = "cursor-0";
      saved.length = 0;

      sync(blog, { stampLastSync: false }, function (err) {
        if (err) return done.fail(err);

        expect(store.account.cursor).toEqual("cursor-1");
        expect(store.account.last_sync).toEqual(12345);
        expect(saved.some((values) => "last_sync" in values)).toBe(false);
        done();
      });
    });
  });

  it("still saves the cursor when update fails for another reason", function (done) {
    const blog = this.blog;

    spyOn(console, "error");
    spyOn(Entry, "set").and.callFake(async function () {
      throw new Error("this file is broken");
    });

    sync(blog, function (err) {
      if (err) return done.fail(err);

      expect(store.account.cursor).toEqual("cursor-1");
      done();
    });
  });
});
