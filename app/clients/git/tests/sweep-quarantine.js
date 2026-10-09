describe("git client sweepQuarantine", function () {
  var fs = require("fs-extra");
  var os = require("os");
  var sweepQuarantine = require("clients/git/sweepQuarantine");

  var DAY = 24 * 60 * 60 * 1000;

  // Writes a quarantine directory holding a 1000 byte file in it, with the
  // directory last modified `ageMs` ago.
  async function quarantine(repo, name, ageMs) {
    var directory = repo + "/objects/" + name;

    await fs.outputFile(directory + "/pack/tmp_pack_x", Buffer.alloc(1000));

    var then = new Date(Date.now() - ageMs);

    await fs.utimes(directory, then, then);

    return directory;
  }

  beforeEach(async function () {
    this.tmp = await fs.mkdtemp(os.tmpdir() + "/sweep-quarantine-");
    this.dataDir = this.tmp + "/git";
    this.repo = this.dataDir + "/example.git";

    await fs.ensureDir(this.repo + "/objects/pack");
    await fs.outputFile(this.repo + "/objects/pack/pack-a.pack", "pack");
  });

  afterEach(async function () {
    await fs.remove(this.tmp);
  });

  it("removes quarantine directories older than a day and leaves newer ones", async function () {
    var old = await quarantine(this.repo, "tmp_objdir-incoming-aaaaaa", 3 * DAY);
    var justOver = await quarantine(
      this.repo,
      "tmp_objdir-incoming-bbbbbb",
      DAY + 60 * 1000
    );
    var recent = await quarantine(this.repo, "tmp_objdir-incoming-cccccc", 60 * 1000);
    var inProgress = await quarantine(
      this.repo,
      "tmp_objdir-incoming-dddddd",
      DAY - 60 * 1000
    );

    var report = await sweepQuarantine({ dataDir: this.dataDir });

    expect(await fs.pathExists(old)).toBe(false);
    expect(await fs.pathExists(justOver)).toBe(false);
    expect(await fs.pathExists(recent)).toBe(true);
    expect(await fs.pathExists(inProgress)).toBe(true);

    expect(report.repositories).toBe(1);
    expect(report.removed).toBe(2);
    expect(report.bytes).toBe(2000);
    expect(report.errors).toBe(0);
    expect(report.directories.length).toBe(2);
    expect(report.directories[0].repository).toBe("example.git");
    expect(report.directories[0].bytes).toBe(1000);
    expect(report.directories.every((d) => d.ageMs > DAY)).toBe(true);
  });

  it("only touches directories with exactly that prefix, directly inside objects", async function () {
    var ancient = 30 * DAY;
    var others = [
      await quarantine(this.repo, "tmp_objdir-other-aaaaaa", ancient),
      await quarantine(this.repo, "xtmp_objdir-incoming-aaaaaa", ancient),
      await quarantine(this.repo, "pack/tmp_objdir-incoming-aaaaaa", ancient),
      await quarantine(this.repo, "ab", ancient),
    ];
    var old = await quarantine(this.repo, "tmp_objdir-incoming-aaaaaa", ancient);

    // an old file (not a directory) with the prefix, and one outside objects/
    await fs.outputFile(this.repo + "/objects/tmp_objdir-incoming-file", "x");
    await fs.utimes(
      this.repo + "/objects/tmp_objdir-incoming-file",
      new Date(Date.now() - ancient),
      new Date(Date.now() - ancient)
    );
    await fs.ensureDir(this.repo + "/tmp_objdir-incoming-outside");
    await fs.utimes(
      this.repo + "/tmp_objdir-incoming-outside",
      new Date(Date.now() - ancient),
      new Date(Date.now() - ancient)
    );

    await sweepQuarantine({ dataDir: this.dataDir });

    expect(await fs.pathExists(old)).toBe(false);

    for (var other of others) {
      expect(await fs.pathExists(other)).toBe(true);
    }

    expect(await fs.pathExists(this.repo + "/objects/tmp_objdir-incoming-file")).toBe(true);
    expect(await fs.pathExists(this.repo + "/tmp_objdir-incoming-outside")).toBe(true);
    expect(await fs.pathExists(this.repo + "/objects/pack/pack-a.pack")).toBe(true);
  });

  it("does not follow symlinks", async function () {
    var target = this.tmp + "/elsewhere";
    var ancient = new Date(Date.now() - 30 * DAY);

    await fs.outputFile(target + "/precious", "keep me");
    await fs.utimes(target, ancient, ancient);

    // a symlink with the prefix, pointing at an old directory outside
    await fs.symlink(target, this.repo + "/objects/tmp_objdir-incoming-link");

    // a quarantine directory containing a symlink to the same place
    var old = await quarantine(this.repo, "tmp_objdir-incoming-aaaaaa", 30 * DAY);
    await fs.symlink(target, old + "/link");
    await fs.utimes(old, ancient, ancient);

    // a repository, and one with objects/, that are symlinks
    await fs.symlink(target, this.dataDir + "/linked.git");
    await fs.ensureDir(this.dataDir + "/linked-objects.git");
    await fs.outputFile(target + "/tmp_objdir-incoming-inside/x", "x");
    await fs.utimes(target + "/tmp_objdir-incoming-inside", ancient, ancient);
    await fs.symlink(target, this.dataDir + "/linked-objects.git/objects");

    var report = await sweepQuarantine({ dataDir: this.dataDir });

    expect(report.errors).toBe(0);
    expect(report.removed).toBe(1);
    expect(await fs.pathExists(old)).toBe(false);
    expect(await fs.pathExists(target + "/precious")).toBe(true);
    expect(await fs.pathExists(target + "/tmp_objdir-incoming-inside/x")).toBe(true);
    expect(
      (await fs.lstat(this.repo + "/objects/tmp_objdir-incoming-link")).isSymbolicLink()
    ).toBe(true);
  });

  it("sweeps every repository and ignores other entries in the data directory", async function () {
    var second = this.dataDir + "/second.git";
    var oldInFirst = await quarantine(this.repo, "tmp_objdir-incoming-aaaaaa", 2 * DAY);
    var oldInSecond = await quarantine(second, "tmp_objdir-incoming-bbbbbb", 2 * DAY);
    var recentInSecond = await quarantine(second, "tmp_objdir-incoming-cccccc", 1000);

    await fs.outputFile(this.dataDir + "/notes.txt", "not a repository");
    await fs.ensureDir(this.dataDir + "/empty.git");

    var report = await sweepQuarantine({ dataDir: this.dataDir });

    expect(report.repositories).toBe(3);
    expect(report.removed).toBe(2);
    expect(await fs.pathExists(oldInFirst)).toBe(false);
    expect(await fs.pathExists(oldInSecond)).toBe(false);
    expect(await fs.pathExists(recentInSecond)).toBe(true);
  });

  it("does nothing when there is nothing to remove", async function () {
    var report = await sweepQuarantine({ dataDir: this.dataDir });

    expect(report).toEqual({
      repositories: 1,
      removed: 0,
      bytes: 0,
      errors: 0,
      directories: [],
    });
  });
});
