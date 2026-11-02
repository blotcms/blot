const fingerprintFiles = require("helper/fingerprintFiles");
const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");

describe("fingerprintFiles", function () {
  beforeEach(async function () {
    this.dir = await fs.mkdtemp(join(os.tmpdir(), "blot-fingerprint-"));
    await fs.outputFile(join(this.dir, "a/b.txt"), "b");
    await fs.outputFile(join(this.dir, "c.txt"), "c");
  });

  afterEach(async function () {
    await fs.remove(this.dir);
  });

  it("is stable while nothing changes", async function () {
    expect(await fingerprintFiles([this.dir])).toEqual(
      await fingerprintFiles([this.dir])
    );
  });

  it("changes when a nested file's modification time does", async function () {
    const before = await fingerprintFiles([this.dir]);
    const later = new Date(Date.now() + 5000);
    await fs.utimes(join(this.dir, "a/b.txt"), later, later);
    expect(await fingerprintFiles([this.dir])).not.toEqual(before);
  });

  it("changes when a file is added or removed", async function () {
    const before = await fingerprintFiles([this.dir]);
    await fs.outputFile(join(this.dir, "d.txt"), "d");
    const added = await fingerprintFiles([this.dir]);
    await fs.remove(join(this.dir, "d.txt"));
    expect(added).not.toEqual(before);
    expect(await fingerprintFiles([this.dir])).toEqual(before);
  });

  it("takes files as well as directories, and ignores missing paths", async function () {
    const file = join(this.dir, "c.txt");
    expect(await fingerprintFiles([file, join(this.dir, "missing")])).toEqual(
      await fingerprintFiles([file])
    );
  });
});
