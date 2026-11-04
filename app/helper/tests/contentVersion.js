describe("contentVersion", function () {
  const os = require("os");
  const path = require("path");
  const fs = require("fs-extra");
  const contentVersion = require("../contentVersion");

  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "content-version-"));
  });

  afterEach(function () {
    fs.removeSync(dir);
  });

  it("returns an 8 character hex digest", async function () {
    const filePath = path.join(dir, "a.txt");
    fs.writeFileSync(filePath, "hello");
    const stat = fs.statSync(filePath);

    const version = await contentVersion(filePath, stat);

    expect(version).toMatch(/^[a-f0-9]{8}$/);
  });

  it("changes when the file's content changes", async function () {
    const filePath = path.join(dir, "a.txt");

    fs.writeFileSync(filePath, "version one");
    const firstVersion = await contentVersion(filePath, fs.statSync(filePath));

    fs.writeFileSync(filePath, "version two");
    const secondVersion = await contentVersion(filePath, fs.statSync(filePath));

    expect(secondVersion).not.toEqual(firstVersion);
  });

  it("stays the same for identical content even after the file is rewritten", async function () {
    const filePath = path.join(dir, "a.txt");

    fs.writeFileSync(filePath, "same content");
    const firstVersion = await contentVersion(filePath, fs.statSync(filePath));

    fs.writeFileSync(filePath, "same content");
    const secondVersion = await contentVersion(filePath, fs.statSync(filePath));

    expect(secondVersion).toEqual(firstVersion);
  });

  it("stays the same when only mtime changes, for identical content", async function () {
    const filePath = path.join(dir, "a.txt");
    fs.writeFileSync(filePath, "unchanged content");

    const firstVersion = await contentVersion(filePath, fs.statSync(filePath));

    fs.utimesSync(filePath, new Date("2030-01-01"), new Date("2030-01-01"));

    const secondVersion = await contentVersion(filePath, fs.statSync(filePath));

    expect(secondVersion).toEqual(firstVersion);
  });

  it("hashes a file larger than the small-file threshold via the streaming path", async function () {
    const filePath = path.join(dir, "large.bin");
    fs.writeFileSync(filePath, Buffer.alloc(300 * 1024, "x"));
    const stat = fs.statSync(filePath);

    const version = await contentVersion(filePath, stat);

    expect(version).toMatch(/^[a-f0-9]{8}$/);
  });

  it("falls back to a size+mtime token above the size cap, without reading the file", async function () {
    // A path that doesn't exist proves the file is never opened: reading it
    // would throw ENOENT and this would fail.
    const filePath = path.join(dir, "does-not-exist.bin");
    const stat = { size: 6 * 1024 * 1024, mtimeMs: 1700000000000 };

    const version = await contentVersion(filePath, stat);
    const version2 = await contentVersion(filePath, stat);

    expect(version).toMatch(/^[a-f0-9]{8}$/);
    expect(version2).toEqual(version);
  });

  describe("fromStat", function () {
    it("returns a size+mtime token synchronously, no file access", function () {
      const stat = { size: 123, mtimeMs: 1700000000000 };

      const version = contentVersion.fromStat(stat);

      expect(version).toMatch(/^[a-f0-9]{8}$/);
      expect(contentVersion.fromStat(stat)).toEqual(version);
    });

    it("changes when size or mtime changes, independent of ctime", function () {
      const base = { size: 123, mtimeMs: 1700000000000, ctime: new Date() };

      const bySize = contentVersion.fromStat({ ...base, size: 124 });
      const byMtime = contentVersion.fromStat({
        ...base,
        mtimeMs: base.mtimeMs + 1,
      });
      const byCtimeOnly = contentVersion.fromStat({
        ...base,
        ctime: new Date(0),
      });

      expect(bySize).not.toEqual(contentVersion.fromStat(base));
      expect(byMtime).not.toEqual(contentVersion.fromStat(base));
      expect(byCtimeOnly).toEqual(contentVersion.fromStat(base));
    });
  });

  describe("fromFolder", function () {
    const folder = require("storage/folder");

    global.test.blog();

    // The token for a file in a blog's folder is the one the same file gets
    // at its local path, in every size class, or every folder link would
    // change and the CDN would have to fetch all of them again.
    [
      ["a small file", 1024],
      ["a file hashed as a stream", 300 * 1024],
      ["a file above the hashing cap", 6 * 1024 * 1024],
    ].forEach(function ([label, size]) {
      it("gives the token contentVersion gives " + label, async function () {
        const filePath = path.join(dir, "file.bin");

        fs.outputFileSync(filePath, Buffer.alloc(size, "x"));
        // A whole-second mtime: models/file keeps modified times to the
        // millisecond, and the size+mtime token uses it as is
        fs.utimesSync(filePath, 1700000000, 1700000000);

        // The same file, with the same modified time, in the blog's folder
        await folder.writeFrom(this.blog.id, "/file.bin", filePath, {
          modified: fs.statSync(filePath).mtimeMs,
        });

        const stat = await folder.stat(this.blog.id, "/file.bin");

        expect(await contentVersion.fromFolder(this.blog.id, "/file.bin", stat)).toEqual(
          await contentVersion(filePath, fs.statSync(filePath))
        );
      });
    });

    it("doesn't read a file above the cap", async function () {
      await folder.write(this.blog.id, "/big.bin", Buffer.alloc(6 * 1024 * 1024, "x"));

      const stat = await folder.stat(this.blog.id, "/big.bin");

      spyOn(fs, "readFile").and.callThrough();
      spyOn(fs, "createReadStream").and.callThrough();

      const version = await contentVersion.fromFolder(this.blog.id, "/big.bin", stat);

      expect(version).toEqual(contentVersion.fromFolderStat(stat));
      expect(fs.readFile).not.toHaveBeenCalled();
      expect(fs.createReadStream).not.toHaveBeenCalled();
    });
  });

  describe("fromFolderStat", function () {
    it("gives the token fromStat gives for the same real file", async function () {
      const filePath = path.join(dir, "a.txt");
      fs.writeFileSync(filePath, "hello");
      // A fractional mtimeMs, which the token must keep exactly
      fs.utimesSync(filePath, 1700000000.123456, 1700000000.123456);

      const stat = fs.statSync(filePath);
      const folderStat = { isDirectory: false, size: stat.size, modified: stat.mtimeMs };

      expect(contentVersion.fromFolderStat(folderStat)).toEqual(contentVersion.fromStat(stat));
    });
  });
});
