describe("helpers bridged with withCallback", function () {
  const fs = require("fs-extra");
  const os = require("os");
  const crypto = require("crypto");
  const { promisify } = require("util");

  beforeEach(async function () {
    this.dir = await fs.mkdtemp(os.tmpdir() + "/blot-helper-bridge-");
    await fs.outputFile(this.dir + "/Folder/File.txt", "hello");
  });

  afterEach(async function () {
    await fs.remove(this.dir);
  });

  it("caseSensitivePath returns a promise without a callback", async function () {
    const caseSensitivePath = require("../caseSensitivePath");
    const result = await caseSensitivePath(this.dir, "/folder/file.txt");
    expect(result).toEqual(this.dir + "/Folder/File.txt");
    await expectAsync(caseSensitivePath(this.dir, "/nope")).toBeRejectedWith(
      jasmine.objectContaining({ code: "ENOENT" })
    );
    expect(typeof caseSensitivePath.pick).toEqual("function");
  });

  it("hashFile works with a promise and with a callback", async function () {
    const hashFile = require("../hashFile");
    const path = this.dir + "/Folder/File.txt";
    const viaPromise = await hashFile(path);
    const viaCallback = await promisify(hashFile)(path);
    expect(viaPromise).toMatch(/^[0-9a-f]{64}$/);
    expect(viaCallback).toEqual(viaPromise);
    await expectAsync(hashFile(this.dir + "/missing")).toBeRejected();
  });

  it("transformer/hash returns the sha1 of a file", async function () {
    const hash = require("../transformer/hash");
    const path = this.dir + "/Folder/File.txt";
    const expected = crypto.createHash("sha1").update("hello").digest("hex");
    expect(await hash(path)).toEqual(expected);
    expect(await promisify(hash)(path)).toEqual(expected);
    await expectAsync(hash(this.dir + "/missing")).toBeRejected();
  });
});
