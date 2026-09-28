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
});
