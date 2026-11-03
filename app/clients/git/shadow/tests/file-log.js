describe("git store shadow mode: the log file", function () {
  var setup = require("./setup");
  var config = require("config");
  var shadow = require("clients/git/shadow");
  var fileLog = require("clients/git/shadow/file-log");
  var fs = require("fs");
  var path = require("path");

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // appendFile calls are not waited for
  async function lines(file) {
    for (var i = 0; i < 50; i++) {
      if (fs.existsSync(file)) break;
      await sleep(20);
    }
    await sleep(50);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  }

  beforeEach(function () {
    fileLog._reset();
  });

  describe("through a push", function () {
    setup();

    it("appends the line it logs, with its timestamp", async function () {
      var file = this.tmp + "/shadow-log/shadow.log";
      config.git_store.shadow_log = file;

      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      // A first push into an empty store is mirrored as an import
      var found = await lines(file);
      var imports = found.filter(function (line) {
        return line.indexOf(" op=import ") !== -1;
      });

      expect(imports.length).toBe(1);
      expect(imports[0]).toMatch(/^\[\d\d\/\w{3}\/\d{4}:[\d: +-]+\] .*\[git-store-shadow\] blog=/);
      expect(imports[0]).toContain("blog=" + this.blog.id);
    });

    it("does not throw, or stop the mirror, when it cannot write", async function () {
      var blocker = this.tmp + "/not-a-directory";
      fs.writeFileSync(blocker, "x");
      config.git_store.shadow_log = path.join(blocker, "shadow.log");
      spyOn(console, "warn");

      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      expect(this.shadowLines("import").length).toBe(1);
      await sleep(100);
      expect(console.warn.calls.count()).toBe(1);
    });
  });

  describe("the file", function () {
    var dir;

    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "shadow-log-"));
    });

    afterEach(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("keeps whole lines from many writes at once", async function () {
      var file = dir + "/shadow.log";
      var line = "x".repeat(5000);

      for (var i = 0; i < 200; i++) fileLog(file, line + i);

      var found = await lines(file);
      await sleep(200);
      found = await lines(file);

      expect(found.length).toBe(200);
      found.forEach(function (text) {
        expect(text.length).toBeGreaterThan(5000);
      });
    });

    it("moves to .1 when it is over its size, replacing an older .1", async function () {
      var file = dir + "/shadow.log";
      fs.writeFileSync(file + ".1", "older\n");
      fs.writeFileSync(file, "a line\n".repeat(100));

      fileLog(file, "new", { maxBytes: 100 });

      var found = await lines(file);

      expect(found).toEqual(["new"]);
      expect(fs.readFileSync(file + ".1", "utf8")).toContain("a line");
      expect(fs.readFileSync(file + ".1", "utf8")).not.toContain("older");
    });

    it("is off when its path is empty", function () {
      expect(function () {
        fileLog("", "x");
      }).not.toThrow();
    });
  });
});
