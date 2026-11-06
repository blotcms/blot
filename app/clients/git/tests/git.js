describe("git client's git wrapper", function () {
  var fs = require("fs-extra");
  var Git = require("clients/git/git");
  var os = require("os");

  beforeEach(async function () {
    this.tmp = await fs.mkdtemp(os.tmpdir() + "/git-wrapper-");
  });

  afterEach(async function () {
    await fs.remove(this.tmp);
  });

  var identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

  it("throws if the directory does not exist", function () {
    var missing = this.tmp + "/missing";

    expect(function () {
      Git(missing);
    }).toThrowError(/does not exist/);
  });

  it("returns git's output exactly as written", async function () {
    var git = Git(this.tmp);

    await git.raw(["init", "-q"]);
    await git.raw([
      ...identity,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first",
    ]);

    var head = await git.raw(["rev-parse", "HEAD"]);

    expect(head).toMatch(/^[0-9a-f]{40}\n$/);
    expect(await git.raw(["config", "--local", "--list"])).toContain("\n");
  });

  it("returns an empty string, not null, for no output", async function () {
    var git = Git(this.tmp);

    await git.raw(["init", "-q"]);

    expect(await git.raw(["status", "--porcelain"])).toBe("");
  });

  it("fails with git's own message when git exits non-zero and writes to stderr", async function () {
    var git = Git(this.tmp);
    var error;

    await git.raw(["init", "-q"]);

    try {
      await git.raw(["add", "--", "nothing-here.txt"]);
    } catch (err) {
      error = err;
    }

    // remove.js matches on this, trailing newline included
    expect(error.message).toBe(
      "fatal: pathspec 'nothing-here.txt' did not match any files\n"
    );
    expect(error.exitCode).toBe(128);
  });

  it("succeeds when git exits non-zero without writing to stderr", async function () {
    var git = Git(this.tmp);

    await git.raw(["init", "-q"]);
    await git.raw([
      ...identity,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first",
    ]);

    // Exits 1, with its message on stdout
    var output = await git.raw([...identity, "commit", "-m", "second"]);

    expect(output).toContain("nothing to commit");

    // Exits 5 when the key is not set
    expect(await git.raw(["config", "--local", "--unset", "no.such"])).toBe("");
  });

  it("calls back with (err, stdout) when given a callback", function (done) {
    var git = Git(this.tmp);

    git.raw(["init", "-q"], function (err) {
      expect(err).toBeNull();

      git.raw(["rev-parse", "--show-toplevel"], function (err, output) {
        expect(err).toBeNull();
        expect(output.trim()).toBe(fs.realpathSync(output.trim()));

        git.raw(["add", "--", "nothing-here.txt"], function (err, output) {
          expect(err.message).toContain("did not match any files");
          expect(output).toBeUndefined();
          done();
        });
      });
    });
  });

  it("runs the commands of one instance one at a time, in order", async function () {
    var git = Git(this.tmp);

    await git.raw(["init", "-q"]);

    // If these ran together, git would fail on config.lock
    var keys = [];
    for (var i = 0; i < 12; i++) keys.push("test.key" + i);

    await Promise.all(
      keys.map(function (key) {
        return git.raw(["config", "--local", key, "value"]);
      })
    );

    var config = await git.raw(["config", "--local", "--list"]);

    keys.forEach(function (key) {
      expect(config).toContain(key + "=value");
    });
  });

  it("keeps running queued commands after one fails", async function () {
    var git = Git(this.tmp);

    await git.raw(["init", "-q"]);

    var results = await Promise.allSettled([
      git.raw(["add", "--", "nothing-here.txt"]),
      git.raw(["config", "--local", "test.key", "value"]),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    expect(await git.raw(["config", "--local", "test.key"])).toBe("value\n");
  });

  it("does not limit output to execFile's default of 1MB", async function () {
    var git = Git(this.tmp);

    await git.raw(["init", "-q"]);
    await fs.outputFile(this.tmp + "/big.txt", "x".repeat(3 * 1024 * 1024));
    await git.raw(["add", "--", "big.txt"]);
    await git.raw([...identity, "commit", "-q", "-m", "big"]);

    var output = await git.raw(["show", "HEAD:big.txt"]);

    expect(output.length).toBe(3 * 1024 * 1024);
  });

  it("adds options.env to the environment", async function () {
    var parent = this.tmp;
    var child = parent + "/child";

    await Git(parent).raw(["init", "-q"]);
    await fs.mkdir(child);

    // Without a ceiling git finds the repository above the folder
    var found = await Git(child).raw(["rev-parse", "--show-toplevel"]);

    expect(found.trim()).toBe(fs.realpathSync(parent));

    var error;

    try {
      await Git(child, { env: { GIT_CEILING_DIRECTORIES: parent } }).raw([
        "rev-parse",
        "--show-toplevel",
      ]);
    } catch (err) {
      error = err;
    }

    expect(error.message).toContain("not a git repository");
  });

  it("passes arguments to git without a shell", async function () {
    var git = Git(this.tmp);

    await git.raw(["init", "-q"]);
    await git.raw([
      "config",
      "--local",
      "test.key",
      "$(echo hi); `echo hi` & 'a b'",
    ]);

    expect(await git.raw(["config", "--local", "test.key"])).toBe(
      "$(echo hi); `echo hi` & 'a b'\n"
    );
  });

  it("refuses arguments that are not an array", function () {
    var git = Git(this.tmp);

    expect(function () {
      git.raw("status");
    }).toThrowError(/must be an array/);
  });
});
