describe("scheduler prune-tmp", function () {
  const fs = require("fs-extra");
  const os = require("os");
  const pruneTmp = require("../prune-tmp");

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // Writes a 1000 byte file at `relative` under the tmp directory, then sets
  // `target` (default: the file itself) last modified `ageMs` ago.
  async function write(root, relative, ageMs, target) {
    await fs.outputFile(root + "/" + relative, Buffer.alloc(1000));

    const then = new Date(Date.now() - ageMs);
    const path = root + "/" + (target || relative);

    await fs.utimes(path, then, then);
  }

  const exists = (path) => fs.pathExists(path);

  beforeEach(async function () {
    this.root = await fs.mkdtemp(os.tmpdir() + "/prune-tmp-");
    this.tmp = this.root + "/tmp";
    await fs.ensureDir(this.tmp);
    this.run = (options) =>
      pruneTmp({ tmpDirectory: this.tmp, ...options });
  });

  afterEach(async function () {
    await fs.remove(this.root);
  });

  it("removes files and directories in tmp older than a day, and keeps newer ones", async function () {
    await write(this.tmp, "old-upload", 2 * DAY);
    await write(this.tmp, "new-upload", HOUR);
    await write(this.tmp, "old-dir/out.html", 2 * DAY, "old-dir");
    await write(this.tmp, "new-dir/out.html", HOUR, "new-dir");

    const report = await this.run();

    expect(await exists(this.tmp + "/old-upload")).toBe(false);
    expect(await exists(this.tmp + "/old-dir")).toBe(false);
    expect(await exists(this.tmp + "/new-upload")).toBe(true);
    expect(await exists(this.tmp + "/new-dir/out.html")).toBe(true);
    expect(report).toEqual({ removed: 2, bytes: 2000, errors: 0 });
  });

  it("does not follow a symlink out of tmp", async function () {
    await write(this.root, "elsewhere/keep.txt", 5 * DAY);
    await fs.symlink(this.root + "/elsewhere", this.tmp + "/link");

    const then = new Date(Date.now() - 2 * DAY);
    await require("fs").promises.lutimes(this.tmp + "/link", then, then);

    await this.run();

    expect(await exists(this.tmp + "/link")).toBe(false);
    expect(await exists(this.root + "/elsewhere/keep.txt")).toBe(true);
  });

  describe("imports", function () {
    const importPath = (root, importID) => root + "/import/blog_1/" + importID;

    // An import directory holding a result.zip, last modified `ageMs` ago
    async function importDirectory(root, importID, ageMs) {
      await write(root, "import/blog_1/" + importID + "/result.zip", ageMs, "import/blog_1/" + importID);
    }

    it("keeps a finished import for longer than other files", async function () {
      await importDirectory(this.tmp, "recent-1", 3 * DAY);
      await importDirectory(this.tmp, "old-2", 8 * DAY);

      // the import root itself is never judged on its own age
      const then = new Date(Date.now() - 30 * DAY);
      await fs.utimes(this.tmp + "/import", then, then);

      await this.run();

      expect(await exists(importPath(this.tmp, "recent-1") + "/result.zip")).toBe(true);
      expect(await exists(importPath(this.tmp, "old-2"))).toBe(false);
      expect(await exists(this.tmp + "/import/blog_1")).toBe(true);
    });

    it("keeps an import whose worker holds a live lease, however old", async function () {
      await importDirectory(this.tmp, "running-3", 30 * DAY);
      await fs.writeJson(importPath(this.tmp, "running-3") + "/running.txt", {
        owner: "worker",
        expiresAt: Date.now() + 30000,
      });
      await importDirectory(this.tmp, "crashed-4", 30 * DAY);
      await fs.writeJson(importPath(this.tmp, "crashed-4") + "/running.txt", {
        owner: "worker",
        expiresAt: Date.now() - DAY,
      });
      // the lease is written after the directory was aged
      const then = new Date(Date.now() - 30 * DAY);
      await fs.utimes(importPath(this.tmp, "running-3"), then, then);
      await fs.utimes(importPath(this.tmp, "crashed-4"), then, then);

      await this.run();

      expect(await exists(importPath(this.tmp, "running-3"))).toBe(true);
      expect(await exists(importPath(this.tmp, "crashed-4"))).toBe(false);
    });
  });

  it("copes with a tmp directory that does not exist yet", async function () {
    await fs.remove(this.tmp);

    const report = await this.run();

    expect(report).toEqual({ removed: 0, bytes: 0, errors: 0 });
  });
});
