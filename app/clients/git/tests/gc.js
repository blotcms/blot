// `git gc --auto` after Blot's commits and pushes (gc.js): a burst of writes
// to a blog makes one gc, never two at once, and it runs in the foreground of
// a process the limiter counts. gc processes are counted by a `git` put first
// on PATH (./setup/spyGit).
describe("git client gc", function () {
  var fs = require("fs-extra");
  var path = require("path");
  var childProcess = require("child_process");
  var gc = require("clients/git/gc");
  var limiter = require("clients/git/limiter");
  var tempDir = require("helper/tempDir");
  var spyGit = require("./setup/spyGit");

  var spy = spyGit();
  var delay;

  beforeEach(function () {
    delay = gc.settings.delay;
    spy.install();
  });

  afterEach(async function () {
    await gc.flush();
    gc.settings.delay = delay;
    spy.restore();
  });

  function gcsIn(directory) {
    return function (command) {
      return command.gitDir === directory && / gc --auto/.test(command.args);
    };
  }

  describe("of a repository", function () {
    // Long enough for the gcs below, each made a second longer
    var TIMEOUT = 30 * 1000;

    beforeEach(async function () {
      // gcs other specs asked for, which would otherwise run alongside these
      await gc.flush();

      this.root = await fs.mkdtemp(path.join(tempDir(), "gc-spec-"));
      this.directory = path.join(this.root, "repo.git");
      childProcess.execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=master", this.directory]);
    }, TIMEOUT);

    afterEach(async function () {
      await fs.remove(this.root);
    });

    it("runs one gc for many asks, and one more for those while it runs", async function () {
      var directory = this.directory;

      gc.settings.delay = 10;

      // Each git takes a second, so the asks below land while it runs
      process.env.GIT_SPY_SLEEP = "1";

      for (var i = 0; i < 50; i++) gc.schedule(directory);

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(spy.commands(gcsIn(directory)).length).toBe(1);

      for (var j = 0; j < 50; j++) gc.schedule(directory);

      await gc.flush();

      var gcs = spy.commands(gcsIn(directory));

      expect(gcs.length).toBe(2);
      expect(spy.mostAtOnce(gcsIn(directory))).toBe(1);
      expect(gcs[0].args).toContain("-c gc.autoDetach=false");
      expect(gcs[0].args).not.toContain("gc.auto=0");
    }, TIMEOUT);

    it("forgets a repository once its gc has run", async function () {
      gc.settings.delay = 0;
      gc.schedule(this.directory);

      await gc.flush();
      gc.schedule(path.join(this.root, "gone.git"));
      await gc.flush();

      expect(spy.commands(gcsIn(this.directory)).length).toBe(1);
      expect(limiter.stats().gc.running).toBe(0);
    }, TIMEOUT);
  });

  describe("after Blot's writes", function () {
    require("./setup")({ clone: false, client: true });

    var util = require("util");
    var write = util.promisify(require("clients/git/write"));
    var repo = require("clients/git/repo");

    afterEach(async function () {
      await this.local.pull();
      await this.local.expectSynced();
    });

    it("makes one gc for a burst of 50 writes to a blog, never two at once", async function () {
      var directory = repo.directory(this.blog.handle);
      for (var i = 0; i < 50; i++) {
        await write(this.blog.id, "/burst/post-" + i + ".txt", "Post " + i);
      }

      // Asked for by every commit, and none has run yet
      expect(spy.commands(gcsIn(directory)).length).toBe(0);

      await gc.flush();

      expect(spy.commands(gcsIn(directory)).length).toBe(1);
      expect(spy.mostAtOnce(gcsIn(directory))).toBe(1);

      // Background git for the burst never went past the cap
      expect(spy.mostAtOnce((command) => command.gitDir === directory)).toBeLessThanOrEqual(
        limiter.stats().background.max
      );
    });
  });
});
