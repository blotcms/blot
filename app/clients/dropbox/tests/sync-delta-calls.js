describe("dropbox sync/index delta calls", function () {
  const syncPath = require.resolve("../sync");
  const lockPath = require.resolve("sync");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");
  const deltaPath = require.resolve("../delta");
  const paths = [syncPath, lockPath, createClientPath, databasePath, deltaPath];
  const originals = {};

  beforeEach(function () {
    paths.forEach((path) => (originals[path] = require.cache[path]));
  });

  afterEach(function () {
    paths.forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
  });

  // Returns how many times delta was called, and how long the sync took
  async function run(batches) {
    require.cache[lockPath] = {
      exports: async function (_blogID, fn) {
        return fn({
          log: function () {},
          status: function () {},
          update: async () => {},
        });
      },
    };
    require.cache[createClientPath] = {
      exports: async () => ({
        error: null,
        client: {},
        account: { folder_id: "", cursor: "old", error_code: 0 },
      }),
    };
    require.cache[databasePath] = { exports: { set: async () => {} } };
    let calls = 0;
    require.cache[deltaPath] = {
      exports: function () {
        return async function () {
          const entries = batches[calls++] || [];
          return { entries, cursor: "new", has_more: false };
        };
      },
    };
    delete require.cache[syncPath];
    const sync = require("../sync");
    const start = Date.now();
    await sync({ id: "blog_syncdeltacalls" });
    return { calls, elapsed: Date.now() - start };
  }

  it("calls delta once, without waiting, when the first answer is empty", async function () {
    const { calls, elapsed } = await run([]);
    expect(calls).toEqual(1);
    expect(elapsed).toBeLessThan(500);
  });

  it("checks once more after a non-empty batch, and stops at an empty answer", async function () {
    const { calls, elapsed } = await run([
      [{ ".tag": "deleted", name: "a", relative_path: "a" }],
    ]);
    expect(calls).toEqual(2);
    expect(elapsed).toBeLessThan(500);
  });
});
