describe("Drive disconnect seizes the folder lock", function () {
  const sync = require("sync");
  const lock = require("sync/lock");
  const client = require("models/client");
  const database = require("../database");
  const disconnect = require("../disconnect");

  global.test.timeout(60 * 1000);
  global.test.blog();

  const FOLDER = "seize-test-folder";

  afterEach(async function () {
    await database.folder(FOLDER, this.blog.id).reset();
    await database.blog.delete(this.blog.id);
    await client.del([
      lock.cancelKey(this.blog.id),
      lock.seizedKey(this.blog.id),
    ]);
  });

  function aborted(signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(signal.reason);
      signal.addEventListener("abort", () => resolve(signal.reason));
    });
  }

  it("stops a running sync, which then can't write Drive's records back", async function () {
    const blogID = this.blog.id;
    await database.blog.store(blogID, {
      folderId: FOLDER,
      serviceAccountId: "service",
    });

    let started;
    const startedSync = new Promise((resolve) => (started = resolve));
    const refused = {};

    const running = sync(blogID, async function (folder) {
      await database.folder(FOLDER, blogID).set("file-1", "/a.txt");
      started();
      await aborted(folder.signal);

      // What a walk would write as it carried on
      for (const [name, write] of Object.entries({
        mapping: () => database.folder(FOLDER, blogID).set("file-2", "/b.txt"),
        account: () => database.blog.update(blogID, { lastSync: Date.now() }),
        dirty: () => database.dirty.add(blogID, ["dir-1"]),
      })) {
        try {
          await write();
        } catch (e) {
          refused[name] = e.code;
        }
      }
    }).catch((e) => e);

    await startedSync;
    await disconnect(blogID);
    await running;

    expect(refused).toEqual({
      mapping: "ECANCELED",
      account: "ECANCELED",
      dirty: "ECANCELED",
    });
    expect(await database.blog.get(blogID)).toBe(null);
    expect(await database.folder(FOLDER, blogID).get("file-1")).toBe(null);
    expect(await database.folder(FOLDER, blogID).get("file-2")).toBe(null);
    expect(await database.dirty.count(blogID)).toEqual(0);
    expect((await lock.inspect(blogID)).held).toBe(false);
  });

  it("leaves Drive's records alone outside a cancelled sync", async function () {
    const blogID = this.blog.id;
    await database.blog.store(blogID, { folderId: FOLDER });
    await database.folder(FOLDER, blogID).set("file-1", "/a.txt");

    expect(await database.folder(FOLDER, blogID).get("file-1")).toEqual(
      "/a.txt"
    );
    expect(await database.blog.update(blogID, { lastSync: 1 })).toBe(true);
  });
});
