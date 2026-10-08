describe("rebuild when Redis is unavailable", function () {
  var Entry = require("models/entry");
  var { SimpleError } = require("redis");
  var { isRedisUnavailableError } = require("helper/redisUnavailable");

  global.test.timeout(15 * 1000);

  global.test.blog();

  it("stops and passes the error on, and the next rebuild builds everything", async function () {
    var first = "/First.txt";
    var second = "/Second.txt";
    var realSet = Entry.set;

    await this.blog.write({ path: first, content: "Title: First" });
    await this.blog.write({ path: second, content: "Title: Second" });

    spyOn(Entry, "set").and.callFake(function (blogID, path, entry, callback) {
      callback(new SimpleError("NOREPLICAS Not enough good replicas to write."));
    });

    var error;

    try {
      await this.blog.rebuild();
    } catch (e) {
      error = e;
    }

    expect(isRedisUnavailableError(error)).toBe(true);

    // It gave up at the first failure instead of trying every path
    expect(Entry.set.calls.count()).toBe(1);

    Entry.set.and.callFake(realSet);

    await this.blog.rebuild();
    await this.blog.check({ path: first, title: "First" });
    await this.blog.check({ path: second, title: "Second" });
  });

  it("carries on past other errors and reports them once", async function () {
    var broken = "/Broken.txt";
    var fine = "/Fine.txt";
    var realSet = Entry.set;
    var log = jasmine.createSpy("log");

    spyOn(console, "error");

    await this.blog.write({ path: broken, content: "Title: Broken" });
    await this.blog.write({ path: fine, content: "Title: Fine" });

    spyOn(Entry, "set").and.callFake(function (blogID, path, entry, callback) {
      if (path === broken) return callback(new Error("this file is broken"));
      realSet.apply(Entry, arguments);
    });

    await this.blog.rebuild({ log: log, status: function () {} });

    await this.blog.check({ path: fine, title: "Fine" });

    var summaries = log.calls.allArgs().filter(function (args) {
      return /failed to build/.test(args.join(" "));
    });

    expect(summaries.length).toBe(1);
    expect(summaries[0].join(" ")).toContain("1 of");
    expect(summaries[0].join(" ")).toContain("this file is broken");
  });

  it("carries on past a path update rejects outright, such as a symlink", async function () {
    var fs = require("fs-extra");
    var os = require("os");
    var path = require("path");
    var fine = "/Fine.txt";
    var log = jasmine.createSpy("log");
    var outside = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-link-"));

    spyOn(console, "error");

    fs.outputFileSync(path.join(outside, "target.txt"), "Title: Linked");
    fs.symlinkSync(
      path.join(outside, "target.txt"),
      path.join(this.blogDirectory, "Link.txt")
    );
    await this.blog.write({ path: fine, content: "Title: Fine" });

    try {
      await this.blog.rebuild({ log: log, status: function () {} });
    } finally {
      fs.removeSync(outside);
    }

    await this.blog.check({ path: fine, title: "Fine" });

    var summaries = log.calls.allArgs().filter(function (args) {
      return /failed to build/.test(args.join(" "));
    });

    expect(summaries.length).toBe(1);
  });
});
