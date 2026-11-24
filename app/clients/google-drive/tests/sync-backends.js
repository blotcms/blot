const crypto = require("crypto");
const fs = require("fs-extra");
const vm = require("vm");
const { dirname, resolve } = require("path");
const { Readable } = require("stream");

// The real sync, download and client database, against a blog folder in S3,
// with Drive played by a fake client. What must hold: an unchanged file is
// neither downloaded nor read, a file changed outside the client is noticed,
// and verified records from before util/hashes.js are taken over
// (#2258, "Content hash").
describe("Google Drive sync against storage/folder", function () {
  const folder = require("storage/folder");
  const database = require("clients/google-drive/database");
  const client = require("models/client");
  const prefix = require("clients/google-drive/database/prefix");
  const hashes = require("clients/google-drive/util/hashes");

  const md5 = (text) => crypto.createHash("md5").update(text).digest("hex");
  const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

  // sync/sync.js, with only the Drive client swapped out
  function loadSync(drive) {
    const file = require.resolve("../sync/sync");
    const module = { exports: {} };

    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
      module,
      exports: module.exports,
      console: { log() {}, error() {} },
      require: (name) => {
        if (name === "../serviceAccount/createDriveClient")
          return async () => drive;
        return require(
          name.startsWith(".") ? resolve(dirname(file), name) : name
        );
      },
    });

    return module.exports;
  }

  // A Drive folder of plain files, { name: contents }, and a record of what
  // was downloaded from it
  function fakeDrive(folderId) {
    const state = { files: {}, downloads: [] };
    const modifiedTime = "2026-01-01T00:00:00.000Z";

    const item = (name) => ({
      id: "id-" + name,
      name,
      mimeType: "text/plain",
      size: String(Buffer.byteLength(state.files[name])),
      md5Checksum: md5(state.files[name]),
      modifiedTime,
    });

    state.drive = {
      files: {
        list: async ({ q }) => ({
          data: {
            files:
              q.indexOf("'" + folderId + "'") === 0
                ? Object.keys(state.files).map(item)
                : [],
          },
        }),
        get: async ({ fileId, alt }) => {
          if (fileId === folderId)
            return { data: { id: folderId, name: "Blog", trashed: false } };
          if (alt !== "media")
            throw new Error("Unexpected request for " + fileId);
          const name = fileId.slice("id-".length);
          state.downloads.push(name);
          return { data: Readable.from([Buffer.from(state.files[name])]) };
        },
      },
    };

    return state;
  }

  function specs() {
    let drive, run, folderId, updates;

    beforeEach(async function () {
      folderId = "folder-" + crypto.randomBytes(6).toString("hex");
      updates = [];
      drive = fakeDrive(folderId);

      await database.blog.store(this.blog.id, {
        folderId,
        folderName: "Blog",
        serviceAccountId: "service-account",
      });

      const sync = loadSync(drive.drive);
      run = () =>
        sync(
          this.blog.id,
          () => {},
          async (path) => updates.push(path)
        );
    });

    afterEach(async function () {
      await database.blog.delete(this.blog.id);
      const keys = await client.keys(prefix + folderId + "*");
      if (keys.length) await client.del(keys);
    });

    // The md5Checksum prefix util/hashes.js has paired with these bytes
    const paired = async (blogID, text) =>
      (await hashes.load(blogID)).get(sha1(text));

    it("downloads new files once, then neither downloads nor reads them", async function () {
      drive.files["a.txt"] = "alpha";
      drive.files["b.txt"] = "bravo!";

      expect(await run()).toBeTruthy();
      expect(drive.downloads.sort()).toEqual(["a.txt", "b.txt"]);
      expect((await folder.read(this.blog.id, "/a.txt")).toString()).toBe(
        "alpha"
      );

      expect(await paired(this.blog.id, "alpha")).toBe(
        md5("alpha").slice(0, 24)
      );

      drive.downloads = [];
      updates = [];
      spyOn(folder, "ensureLocal").and.callThrough();
      spyOn(folder, "stat").and.callThrough();

      expect(await run()).toBeTruthy();
      expect(drive.downloads).toEqual([]);
      expect(updates).toEqual([]);
      expect(folder.ensureLocal).not.toHaveBeenCalled();
      expect(folder.stat).not.toHaveBeenCalled();
    });

    it("downloads a file changed outside the client again", async function () {
      drive.files["a.txt"] = "alpha";
      expect(await run()).toBeTruthy();

      // Same size, different bytes, written behind the client's back
      await new Promise((resolve) => setTimeout(resolve, 5));
      await folder.write(this.blog.id, "/a.txt", "ALPHA");
      drive.downloads = [];

      expect(await run()).toBeTruthy();
      expect(drive.downloads).toEqual(["a.txt"]);
      expect((await folder.read(this.blog.id, "/a.txt")).toString()).toBe(
        "alpha"
      );
      expect(updates).toContain("/a.txt");
    });

    it("trusts a file written again with the same bytes, by its SHA-1", async function () {
      drive.files["a.txt"] = "alpha";
      expect(await run()).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 5));
      await folder.write(this.blog.id, "/a.txt", "alpha");
      drive.downloads = [];
      updates = [];
      spyOn(folder, "ensureLocal").and.callThrough();

      expect(await run()).toBeTruthy();
      expect(drive.downloads).toEqual([]);
      expect(updates).toEqual([]);
      expect(folder.ensureLocal).not.toHaveBeenCalled();
    });

    it("removes a file removed from Drive", async function () {
      drive.files["a.txt"] = "alpha";
      drive.files["b.txt"] = "bravo";
      expect(await run()).toBeTruthy();

      delete drive.files["b.txt"];

      expect(await run()).toBeTruthy();
      expect(await folder.exists(this.blog.id, "/b.txt")).toBe(false);
      expect(await folder.exists(this.blog.id, "/a.txt")).toBe(true);
      expect(updates).toContain("/b.txt");
    });

    it("takes over a verified record from before util/hashes.js, without reading the file", async function () {
      drive.files["a.txt"] = "alpha";
      await folder.write(this.blog.id, "/a.txt", "alpha");
      const contentKey = database.folder(folderId, this.blog.id).contentKey;
      await client.hSet(
        contentKey,
        "id-a.txt",
        JSON.stringify({
          path: "/a.txt",
          checksum: md5("alpha"),
          sha1: sha1("alpha"),
          size: 5,
          modified: 1000,
        })
      );
      spyOn(folder, "ensureLocal").and.callThrough();

      expect(await run()).toBeTruthy();
      expect(drive.downloads).toEqual([]);
      expect(folder.ensureLocal).not.toHaveBeenCalled();
      expect(await paired(this.blog.id, "alpha")).toBe(
        md5("alpha").slice(0, 24)
      );
    });

    it("pairs a file whose old record can't be taken over by checking it, not downloading it", async function () {
      drive.files["a.txt"] = "alpha";
      await folder.write(this.blog.id, "/a.txt", "alpha");
      // The record as it was before this client kept each file's state: the
      // file's fingerprint on disk, which S3 has no way to match
      const contentKey = database.folder(folderId, this.blog.id).contentKey;
      await client.hSet(
        contentKey,
        "id-a.txt",
        JSON.stringify({
          path: "/a.txt",
          checksum: md5("alpha"),
          fingerprint: "5:1000000000",
        })
      );

      expect(await run()).toBeTruthy();
      expect(drive.downloads).toEqual([]);
      expect(await paired(this.blog.id, "alpha")).toBe(
        md5("alpha").slice(0, 24)
      );
    });
  }

  global.test.blog();

  specs();

  describe("on S3", function () {
    it("lists the folder without a local copy of any directory", async function () {
      await folder.write(this.blog.id, "/dir/a.txt", "alpha");
      spyOn(folder, "ensureLocal").and.callThrough();

      const entries = await require("../sync/util/localReaddir")(
        this.blog.id,
        "/dir"
      );

      expect(entries.map((entry) => entry.name)).toEqual(["a.txt"]);
      expect(folder.ensureLocal).not.toHaveBeenCalled();
    });
  });
});
