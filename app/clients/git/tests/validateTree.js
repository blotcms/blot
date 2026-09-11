const assert = require("assert");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const execFile = require("util").promisify(require("child_process").execFile);
const validateTree = require("../validateTree");

describe("Git tree validation", function () {
  let dir, git;
  beforeEach(async function () {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "blot-tree-test-"));
    git = { raw: async args => (await execFile("git", ["-C", dir, ...args])).stdout };
    await git.raw(["init", "-q"]);
    await fs.writeFile(path.join(dir, "ordinary.txt"), "ordinary");
  });
  afterEach(async function () { await fs.rm(dir, { recursive: true, force: true }); });
  async function commit() {
    await git.raw(["add", "."]);
    await git.raw(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test"]);
  }
  it("returns an immutable commit for regular files", async function () {
    await commit();
    expect(await validateTree(git, "HEAD")).toEqual((await git.raw(["rev-parse", "HEAD"])).trim());
  });
  it("rejects a nested symbolic link before checkout", async function () {
    await fs.mkdir(path.join(dir, "nested"));
    await fs.symlink("../ordinary.txt", path.join(dir, "nested", "link.txt"));
    await commit();
    await assert.rejects(validateTree(git, "HEAD"), /regular files only/);
  });
  it("rejects submodules", async function () {
    await assert.rejects(validateTree({raw: async args => args[0] === "rev-parse" ? "abc" : "160000 commit abc\tsubmodule\0"}, "HEAD"), /regular files only/);
  });
});
