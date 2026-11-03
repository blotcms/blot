// How much git the client runs at once (limiter.js): each lane's cap, that a
// full background lane never holds up a push or a clone, and the memory
// settings every git command runs with. Commands are counted by a `git` put
// first on PATH (./setup/spyGit) which logs when each starts and when the
// real git under it has exited.
describe("git client limiter", function () {
  var fs = require("fs-extra");
  var path = require("path");
  var childProcess = require("child_process");
  var limiter = require("clients/git/limiter");
  var createLimiter = limiter.createLimiter;
  var tempDir = require("helper/tempDir");
  var spyGit = require("./setup/spyGit");

  function deferred() {
    var out = {};
    out.promise = new Promise(function (resolve) {
      out.resolve = resolve;
    });
    return out;
  }

  // Lets queued work start and settle
  function settle() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 20);
    });
  }

  describe("lanes", function () {
    it("runs at most each lane's cap at once, in the order asked", async function () {
      var lanes = createLimiter({ interactive: 2, background: 3 });
      var running = { interactive: 0, background: 0 };
      var most = { interactive: 0, background: 0 };
      var order = [];
      var holds = [];
      var done = [];

      ["interactive", "background"].forEach(function (lane) {
        for (var i = 0; i < 8; i++) {
          (function (i) {
            var hold = deferred();
            holds.push(hold);
            done.push(
              lanes.run(lane, function () {
                running[lane]++;
                most[lane] = Math.max(most[lane], running[lane]);
                order.push(lane + i);
                return hold.promise.then(function () {
                  running[lane]--;
                });
              })
            );
          })(i);
        }
      });

      await settle();
      expect(running).toEqual({ interactive: 2, background: 3 });
      expect(lanes.stats().interactive.waiting).toBe(6);
      expect(lanes.stats().background.waiting).toBe(5);

      // Released one at a time, each lets exactly one more in
      for (var hold of holds) {
        hold.resolve();
        await settle();
      }

      await Promise.all(done);

      expect(most).toEqual({ interactive: 2, background: 3 });
      expect(order.filter((name) => name.indexOf("background") === 0)).toEqual(
        [0, 1, 2, 3, 4, 5, 6, 7].map((i) => "background" + i)
      );
      expect(lanes.stats().background.started).toBe(8);
    });

    it("never makes interactive work wait for a full background lane", async function () {
      var lanes = createLimiter({ interactive: 1, background: 1 });
      var hold = deferred();
      var background = [];

      for (var i = 0; i < 50; i++) {
        background.push(
          lanes.run("background", function () {
            return hold.promise;
          })
        );
      }

      var interactive = await lanes.run("interactive", function () {
        return "served";
      });

      expect(interactive).toBe("served");
      expect(lanes.stats().background.waiting).toBe(49);

      hold.resolve();
      await Promise.all(background);
    });

    it("holds a place until the work has settled, however it ends", async function () {
      var lanes = createLimiter({ interactive: 1, background: 1 });

      function failure(promise) {
        return promise.then(
          () => null,
          (err) => err.message
        );
      }

      expect(await failure(lanes.run("background", () => Promise.reject(new Error("git failed"))))).toBe("git failed");
      expect(
        await failure(
          lanes.run("background", function () {
            throw new Error("could not spawn");
          })
        )
      ).toBe("could not spawn");

      expect(await lanes.run("background", () => "still room")).toBe("still room");
      expect(lanes.stats().background.running).toBe(0);
    });

    it("does not wait again for work started inside a place it holds, but does outside it", async function () {
      var lanes = createLimiter({ interactive: 1, background: 1 });
      var later = null;

      var result = await lanes.run("background", async function () {
        // Blot's commit: several commands in one place, one after another
        var first = await lanes.run("background", () => "one");
        var second = await lanes.run("background", () => "two");

        // A sync started from inside, which must wait its turn
        later = lanes.outside(function () {
          return lanes.run("background", () => "after");
        });

        await settle();
        expect(lanes.stats().background.waiting).toBe(1);

        return first + second;
      });

      expect(result).toBe("onetwo");
      expect(await later).toBe("after");
      expect(lanes.stats().background.started).toBe(2);
    });
  });

  describe("settings", function () {
    it("puts the memory settings in front of every command but config", function () {
      var args = limiter.args(["upload-pack", "--stateless-rpc", "/repo.git"]);

      expect(args.slice(-3)).toEqual(["upload-pack", "--stateless-rpc", "/repo.git"]);
      [
        "pack.threads=1",
        "pack.windowMemory=16m",
        "pack.deltaCacheSize=16m",
        "core.deltaBaseCacheLimit=16m",
        "core.bigFileThreshold=16m",
        "core.packedGitLimit=64m",
        "core.packedGitWindowSize=16m",
        "gc.auto=0",
        "maintenance.auto=false",
      ].forEach(function (setting) {
        expect(args[args.indexOf(setting) - 1]).toBe("-c");
      });

      expect(limiter.args(["config", "--local", "gc.auto"])).toEqual(["config", "--local", "gc.auto"]);
    });

    it("finds the command after git's own options, and never lets one start a gc", function () {
      expect(limiter.subcommand(["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--all"])).toBe("fetch");
      expect(limiter.args(["gc", "--auto"])).toContain("gc.auto=0");
    });

    it("lets the stuck-process sweep recognise git started with them", async function () {
      var stuckProcesses = require("clients/git/stuckProcesses");
      var line = "git " + limiter.args(["index-pack", "--stdin"]).join(" ");
      var stuck = await stuckProcesses({
        maxAgeSeconds: 60,
        ps: async () => "   41  2:00:01   9000 " + line + "\n   42  2:00:01   9000 git -c a=b log\n",
      });

      expect(stuck.map((process) => process.pid)).toEqual([41]);
    });
  });

  describe("git processes", function () {
    var spy = spyGit();
    var caps;

    beforeEach(async function () {
      caps = limiter.stats();
      this.root = await fs.mkdtemp(path.join(tempDir(), "limiter-spec-"));
      this.repositories = [];

      for (var i = 0; i < 4; i++) {
        var directory = path.join(this.root, "repo-" + i + ".git");
        childProcess.execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=master", directory]);
        this.repositories.push(directory);
      }

      spy.install();
    });

    afterEach(async function () {
      spy.restore();
      limiter.reset({ interactive: caps.interactive.max, background: caps.background.max });
      await fs.remove(this.root);
    });

    function ours(root) {
      return function (command) {
        return (command.gitDir + command.cwd).indexOf(root) !== -1;
      };
    }

    it("never runs more background git processes than the cap, each counted until it has exited", async function () {
      var Git = require("clients/git/git");

      limiter.reset({ background: 2 });

      await Promise.all(
        this.repositories.map(function (directory) {
          var git = Git(directory);
          return Promise.all([0, 1, 2, 3, 4].map(() => git.raw(["for-each-ref"])));
        })
      );

      var commands = spy.commands(ours(this.root));

      expect(commands.length).toBe(4 * 5);
      expect(spy.mostAtOnce(ours(this.root))).toBe(2);

      // Every command had the settings, and none was left running
      commands.forEach(function (command) {
        expect(command.args).toContain("-c core.packedGitLimit=64m");
        expect(command.args).toContain("-c pack.windowMemory=16m");
        expect(command.ended).toBe(true);
      });
    });

    it("serves interactive git while the background lane is full", async function () {
      var Git = require("clients/git/git");
      var directory = this.repositories[0];
      var hold = deferred();

      limiter.reset({ background: 1 });

      var holding = limiter.run("background", () => hold.promise);
      var waiting = Git(directory).raw(["rev-parse", "--git-dir"]);
      var waited = false;

      waiting.then(function () {
        waited = true;
      });

      var served = await Git(directory, { lane: "interactive" }).raw(["for-each-ref"]);

      expect(served).toBe("");
      await settle();
      expect(waited).toBe(false);

      hold.resolve();
      await holding;
      expect((await waiting).trim()).toBe(".");
    });

    it("sees the settings in git itself, and leaves config alone", async function () {
      var Git = require("clients/git/git");

      await Git(this.repositories[0]).raw(["config", "--local", "gc.auto", "123"]);
      expect(await Git(this.repositories[0]).raw(["config", "--local", "gc.auto"])).toBe("123\n");
      expect(await Git(this.repositories[0]).raw(["config", "gc.auto"])).toBe("123\n");
    });

    it("lets git see the settings", async function () {
      var Git = require("clients/git/git");
      var output = await Git(this.repositories[0]).raw(["var", "-l"]);

      expect(output).toContain("core.packedgitlimit=64m");
      expect(output).toContain("core.bigfilethreshold=16m");
      expect(output).toContain("gc.auto=0");
    });
  });

  describe("a user's push and fetch", function () {
    require("./setup")({ clone: false, client: true });

    var caps;

    beforeEach(function () {
      caps = limiter.stats();
    });

    afterEach(async function () {
      limiter.reset({ background: caps.background.max });
      await this.local.expectSynced();
    });

    it("are served while Blot's own git waits for room", async function () {
      var hold = deferred();

      limiter.reset({ background: 1 });

      var holding = limiter.run("background", () => hold.promise);

      await this.local.commitFiles({ "/pushed.txt": "Pushed" });

      // The store's receive (index-pack and its checks), then two reads
      expect((await this.local.tryPush()).code).toBe(0);
      expect(await this.local.remoteHead()).toBe(await this.local.head());
      expect((await this.local.git(["fetch", "origin"])).code).toBe(0);
      expect(limiter.stats().background.running).toBe(1);

      hold.resolve();
      await holding;
      await this.local.waitForSync();
    });
  });
});
