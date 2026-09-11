const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const assertNoSymlinks = require("../assertNoSymlinks");

describe("assertNoSymlinks", function () {
  let dir;
  beforeEach(async function () {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "blot-links-test-"));
    await fs.mkdir(path.join(dir, "folder"));
    await fs.writeFile(path.join(dir, "folder", "file.txt"), "ordinary");
  });
  afterEach(async function () { await fs.rm(dir, { recursive: true, force: true }); });
  it("allows normal and deleted paths", async function () {
    await assertNoSymlinks(dir, path.join(dir, "folder/file.txt"));
    await assertNoSymlinks(dir, path.join(dir, "missing/file.txt"));
  });
  it("rejects file and ancestor links including dangling links", async function () {
    await fs.symlink("folder", path.join(dir, "link"));
    await fs.symlink("missing", path.join(dir, "dangling"));
    await expectAsync(assertNoSymlinks(dir, path.join(dir, "link/file.txt"))).toBeRejected();
    await expectAsync(assertNoSymlinks(dir, path.join(dir, "dangling"))).toBeRejected();
  });
  it("rejects paths outside the root", async function () {
    await expectAsync(assertNoSymlinks(dir, path.join(dir, "../outside"))).toBeRejected();
  });
});
