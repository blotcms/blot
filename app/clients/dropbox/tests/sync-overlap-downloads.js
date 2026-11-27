// Downloads run alongside the updates of earlier files, a few at a time, with
// the writes into the folder one at a time.
describe("dropbox sync/index overlapping downloads", function () {
  const syncPath = require.resolve("../sync");
  const lockPath = require.resolve("sync");
  const createClientPath = require.resolve("../util/createClient");
  const databasePath = require.resolve("../database");
  const deltaPath = require.resolve("../delta");
  const downloadPath = require.resolve("../util/download");
  const paths = [
    syncPath,
    lockPath,
    createClientPath,
    databasePath,
    deltaPath,
    downloadPath,
  ];
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

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function until(condition) {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting");
      await wait(2);
    }
  }

  const files = (count) =>
    Array.from({ length: count }, (_, i) => ({
      ".tag": "file",
      name: "f" + i + ".txt",
      path_display: "/f" + i + ".txt",
      relative_path: "f" + i + ".txt",
      size: 1,
    }));

  // download(source, options) and update(path) are the stubs under test; the
  // sync resolves (or rejects) with their record in `events`
  function run({ entries, download, update }) {
    const events = [];

    require.cache[lockPath] = {
      exports: async function (_blogID, fn) {
        return fn({
          signal: new AbortController().signal,
          log: function () {},
          status: function () {},
          update: async (path) => {
            events.push("update start " + path);
            try {
              if (update) await update(path);
            } finally {
              events.push("update end " + path);
            }
          },
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
          return {
            entries: calls++ === 0 ? entries : [],
            cursor: "new",
            has_more: false,
          };
        };
      },
    };
    require.cache[downloadPath] = {
      exports: async function (_client, source, _blogID, _dest, options) {
        events.push("download start " + source);
        await download(source, options);
        events.push("download end " + source);
      },
    };
    delete require.cache[syncPath];
    const sync = require("../sync");
    return { events, done: sync({ id: "blog_overlapdownloads" }) };
  }

  it("starts later downloads before the first update finishes, with updates in order and one at a time", async function () {
    let releaseFirst;
    const firstUpdate = new Promise((resolve) => (releaseFirst = resolve));
    let updating = 0;
    let overlapped = false;

    const { events, done } = run({
      entries: files(3),
      download: () => wait(5),
      update: async (path) => {
        if (++updating > 1) overlapped = true;
        if (path === "f0.txt") await firstUpdate;
        else await wait(1);
        updating--;
      },
    });

    // The first update is held open; wait for it to have started as well as
    // for the later download, as either can come first
    await until(
      () =>
        events.includes("download start /f2.txt") &&
        events.includes("update start f0.txt")
    );
    expect(events).not.toContain("update end f0.txt");

    releaseFirst();
    await done;

    const updates = events.filter((e) => e.startsWith("update start"));
    expect(updates).toEqual([
      "update start f0.txt",
      "update start f1.txt",
      "update start f2.txt",
    ]);
    expect(overlapped).toBe(false);
  });

  it("downloads at most 4 files at once", async function () {
    let running = 0;
    let most = 0;

    const { done } = run({
      entries: files(10),
      download: async () => {
        most = Math.max(most, ++running);
        await wait(15);
        running--;
      },
    });
    await done;

    expect(most).toBe(4);
  });

  it("never overlaps writes into the folder", async function () {
    let writing = 0;
    let overlapped = false;
    let writes = 0;

    const { done } = run({
      entries: files(8),
      download: async (_source, options) => {
        await wait(5);
        await options.publish(async () => {
          if (++writing > 1) overlapped = true;
          await wait(3);
          writing--;
          writes++;
        });
      },
    });
    await done;

    expect(writes).toBe(8);
    expect(overlapped).toBe(false);
  });

  it("waits for running downloads before a throw from the loop propagates", async function () {
    let running = 0;
    // A Redis outage is recognised by its constructor's name
    // (helper/redisUnavailable), so the spec throws one of that class
    class ClientOfflineError extends Error {}
    const err = new ClientOfflineError("Redis down");

    const { done } = run({
      entries: files(6),
      download: async () => {
        running++;
        await wait(60);
        running--;
      },
      update: async () => {
        throw err;
      },
    });

    await expectAsync(done).toBeRejectedWith(err);
    expect(running).toBe(0);
  });
});
