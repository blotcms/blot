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

    spyOn(Entry, "set").and.callFake(async function () {
      throw new SimpleError("NOREPLICAS Not enough good replicas to write.");
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

    spyOn(Entry, "set").and.callFake(async function (blogID, path, entry) {
      if (path === broken) throw new Error("this file is broken");
      return realSet.apply(Entry, arguments);
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

  it("carries on past a path update rejects outright", async function () {
    var storage = require("storage/folder");
    var realStat = storage.stat;
    var broken = "/Broken.txt";
    var fine = "/Fine.txt";
    var log = jasmine.createSpy("log");

    spyOn(console, "error");

    await this.blog.write({ path: broken, content: "Title: Broken" });
    await this.blog.write({ path: fine, content: "Title: Fine" });

    // update stats its path first, and a symlink in the way rejects there
    spyOn(storage, "stat").and.callFake(function (blogID, path, options) {
      if (path === broken) {
        return Promise.reject(
          Object.assign(new Error("Symbolic links are not supported"), {
            code: "ELOOP",
          })
        );
      }

      return realStat(blogID, path, options);
    });

    await this.blog.rebuild({ log: log, status: function () {} });
    await this.blog.check({ path: fine, title: "Fine" });

    var summaries = log.calls.allArgs().filter(function (args) {
      return /failed to build/.test(args.join(" "));
    });

    expect(summaries.length).toBe(1);
  });
});
