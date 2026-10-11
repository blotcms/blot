describe("onedrive reset", function () {
  const nock = require("nock");
  const fs = require("fs-extra");
  const { promisify } = require("util");
  const localPath = require("helper/localPath");
  const database = require("../database");
  const resetFromBlot = require("../sync/reset-from-blot");
  const resetToBlot = require("../sync/reset-to-blot");
  const { connect, item, sha1 } = require("./helpers");

  const GRAPH = "https://graph.microsoft.com";
  const get = promisify(database.get);
  const publish = function () {};

  // Create test blog
  global.test.blog();

  beforeEach(async function () {
    await fs.emptyDir(localPath(this.blog.id, "/"));
    await connect(this.blog.id);
  });

  afterEach(function () {
    nock.cleanAll();
  });

  function folderExists() {
    return nock(GRAPH)
      .get((uri) => uri.startsWith("/v1.0/me/drive/items/FOLDER?"))
      .reply(200, { id: "FOLDER", name: "Site" });
  }

  function children(items, id) {
    return nock(GRAPH)
      .get((uri) => uri.startsWith("/v1.0/me/drive/items/" + (id || "FOLDER") + "/children"))
      .reply(200, { value: items });
  }

  describe("from Blot", function () {
    it("uploads new files, skips identical ones and deletes extras", async function () {
      const root = localPath(this.blog.id, "/");
      await fs.outputFile(root + "/keep.txt", "keep");
      await fs.outputFile(root + "/new.txt", "new");

      folderExists();
      children([
        item("keep.txt", { sha1: sha1("keep") }),
        item("stale.txt", { sha1: sha1("stale") }),
      ]);

      const deleted = nock(GRAPH)
        .delete("/v1.0/me/drive/items/FOLDER:/stale.txt:")
        .reply(204);
      const uploaded = nock(GRAPH)
        .put((uri) => uri.startsWith("/v1.0/me/drive/items/FOLDER:/new.txt:/content"))
        .reply(201, {});

      await resetFromBlot(this.blog.id, publish);

      expect(deleted.isDone()).toBe(true);
      expect(uploaded.isDone()).toBe(true);
      // keep.txt was not re-uploaded: no other PUT was mocked
      expect(nock.pendingMocks()).toEqual([]);
    });

    it("flags the account when the folder has been deleted", async function () {
      nock(GRAPH)
        .get((uri) => uri.startsWith("/v1.0/me/drive/items/FOLDER?"))
        .reply(404, { error: { code: "itemNotFound" } });

      let error;

      try {
        await resetFromBlot(this.blog.id, publish);
      } catch (e) {
        error = e;
      }

      expect(error.status).toBe(404);
      expect((await get(this.blog.id)).error_code).toBe(404);
    });

    it("stops and flags the account when storage is full", async function () {
      const root = localPath(this.blog.id, "/");
      await fs.outputFile(root + "/a.txt", "a");

      folderExists();
      children([]);
      nock(GRAPH)
        .put((uri) => uri.startsWith("/v1.0/me/drive/items/FOLDER:/a.txt:/content"))
        .reply(507, { error: { code: "quotaLimitReached" } });

      let error;

      try {
        await resetFromBlot(this.blog.id, publish);
      } catch (e) {
        error = e;
      }

      expect(error.status).toBe(507);
      expect((await get(this.blog.id)).error_code).toBe(507);
    });
  });

  describe("to Blot", function () {
    it("downloads new and changed files, walks folders and removes extras", async function () {
      const root = localPath(this.blog.id, "/");
      await fs.outputFile(root + "/keep.txt", "keep");
      await fs.outputFile(root + "/extra.txt", "extra");

      folderExists();
      children([
        item("keep.txt", { sha1: sha1("keep") }),
        item("new.txt", { sha1: sha1("new"), size: 3 }),
        item("sub", { folder: true, id: "SUB" }),
      ]);
      children([item("deep.txt", { sha1: sha1("deep"), size: 4 })], "FOLDER:/sub:");
      nock(GRAPH).get("/v1.0/me/drive/items/id-new.txt/content").reply(200, "new");
      nock(GRAPH).get("/v1.0/me/drive/items/id-deep.txt/content").reply(200, "deep");

      const updated = [];

      await resetToBlot(this.blog.id, publish, async (path) => updated.push(path));

      expect(await fs.readFile(root + "/new.txt", "utf8")).toBe("new");
      expect(await fs.readFile(root + "/sub/deep.txt", "utf8")).toBe("deep");
      expect(await fs.pathExists(root + "/extra.txt")).toBe(false);
      expect(await fs.readFile(root + "/keep.txt", "utf8")).toBe("keep");
      expect(updated.sort()).toEqual(
        ["/extra.txt", "/new.txt", "/sub", "/sub/deep.txt"].sort()
      );
    });
  });
});
