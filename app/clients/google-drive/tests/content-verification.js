const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const crypto = require("crypto");
const vm = require("vm");
const verify = require("../util/verifyContent");
const fingerprint = require("../util/contentFingerprint");
const checksum = require("../util/md5Checksum");
const digest = value => crypto.createHash("md5").update(value).digest("hex");
const sha1 = value => crypto.createHash("sha1").update(value).digest("hex");

describe("Drive verified content on disk", function () {
  let directory, filename;
  beforeEach(async function () {
    directory = await fs.mkdtemp(join(os.tmpdir(), "drive-verification-"));
    filename = join(directory, "entry.txt");
    await fs.writeFile(filename, "aaaa");
  });
  afterEach(async function () { await fs.remove(directory); });

  it("gives a matching checksum with the file's SHA-1, from one read", async function () {
    expect(await verify(filename, digest("aaaa"))).toEqual({
      checksum: digest("aaaa"),
      sha1: sha1("aaaa"),
    });
  });

  it("does not vouch for a same-size edit", async function () {
    await fs.writeFile(filename, "bbbb");
    expect(await verify(filename, digest("aaaa"))).toBeNull();
    expect((await verify(filename, digest("bbbb"))).sha1).toBe(sha1("bbbb"));
  });

  it("hashes a file with both MD5 and SHA-1, or gives null for one it can't read", async function () {
    expect(await checksum(filename)).toBe(digest("aaaa"));
    expect(await checksum.withSha1(filename)).toEqual({ md5: digest("aaaa"), sha1: sha1("aaaa") });
    expect(await checksum.withSha1(directory)).toBeNull();
    expect(await checksum(join(directory, "missing"))).toBeNull();
  });

  it("is size and nanosecond mtime only, with no inode, device or ctime", async function () {
    const stat = await fs.stat(filename, { bigint: true });
    expect(fingerprint(stat)).toBe(stat.size + ":" + stat.mtimeNs);
  });

  it("accepts stored five-field fingerprints only while size and mtime match", function () {
    const same = fingerprint.sameFingerprint;
    expect(same("1:2:4:1000:3000", "4:1000")).toBe(true);
    expect(same("1:2:4:1000:3000", "4:1001")).toBe(false);
    expect(same("1:2:4:1000:3000", "5:1000")).toBe(false);
    expect(same("4:1000", "4:1000")).toBe(true);
    expect(same("4:1000", "4:1001")).toBe(false);
    expect(same(null, "4:1000")).toBe(false);
    expect(same("4:1000", null)).toBe(false);
    expect(same("", "")).toBe(false);
  });

  it("declines verification if the file changes while its checksum is being established", async function () {
    const module = { exports: {} };
    const racingChecksum = {
      withSha1: async path => {
        const result = await checksum.withSha1(path);
        await fs.writeFile(path, "bbbb");
        return result;
      },
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
