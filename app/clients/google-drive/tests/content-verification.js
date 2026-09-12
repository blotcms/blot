const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const crypto = require("crypto");
const vm = require("vm");
const verify = require("../util/verifyContent");
const fingerprint = require("../util/contentFingerprint");
const checksum = require("../util/md5Checksum");
const digest = value => crypto.createHash("md5").update(value).digest("hex");

describe("Drive verified content on disk", function () {
  let directory, filename;
  beforeEach(async function () {
    directory = await fs.mkdtemp(join(os.tmpdir(), "drive-verification-"));
    filename = join(directory, "entry.txt");
    await fs.writeFile(filename, "aaaa");
  });
  afterEach(async function () { await fs.remove(directory); });

  it("binds a matching checksum to the actual file fingerprint", async function () {
    expect(await verify(filename, digest("aaaa"))).toEqual({
      checksum: digest("aaaa"),
      fingerprint: fingerprint(await fs.stat(filename, { bigint: true })),
    });
  });

  it("invalidates same-size edits even when the old modification time is restored", async function () {
    const original = await verify(filename, digest("aaaa"));
    const stat = await fs.stat(filename);
    await fs.writeFile(filename, "bbbb");
    await fs.utimes(filename, stat.atime, stat.mtime);
    expect(await verify(filename, digest("aaaa"))).toBeNull();
    const changed = await verify(filename, digest("bbbb"));
    expect(changed.fingerprint).not.toBe(original.fingerprint);
  });

  it("invalidates replacement by a different inode with identical bytes", async function () {
    const original = await verify(filename, digest("aaaa"));
    const stat = await fs.stat(filename);
    const replacement = join(directory, "replacement.txt");
    await fs.writeFile(replacement, "aaaa");
    await fs.utimes(replacement, stat.atime, stat.mtime);
    await fs.rename(replacement, filename);
    const replaced = await verify(filename, digest("aaaa"));
    expect(replaced.checksum).toBe(original.checksum);
    expect(replaced.fingerprint).not.toBe(original.fingerprint);
  });

  it("declines verification if the file changes while its checksum is being established", async function () {
    const module = { exports: {} };
    const racingChecksum = async path => {
      const result = await checksum(path);
      const stat = await fs.stat(path);
      await fs.writeFile(path, "bbbb");
      await fs.utimes(path, stat.atime, stat.mtime);
      return result;
    };
    vm.runInNewContext(fs.readFileSync(require.resolve("../util/verifyContent"), "utf8"), {
      module,
      require: name => ({
        "fs-extra": fs,
        "./contentFingerprint": fingerprint,
        "./md5Checksum": racingChecksum,
      })[name],
    });
    expect(await module.exports(filename, digest("aaaa"))).toBeNull();
  });

  it("does not certify a missing file, directory, or absent remote checksum", async function () {
    expect(await verify(join(directory, "missing"), digest("aaaa"))).toBeNull();
    expect(await verify(directory, digest("aaaa"))).toBeNull();
    expect(await verify(filename, undefined)).toBeNull();
  });
});
