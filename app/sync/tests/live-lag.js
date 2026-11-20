describe("sync live lag", function () {
  const sync = require("../index");
  const storage = require("storage/folder");

  global.test.blog();

  // The lines sync's log wrote that report a lag
  function lagLines() {
    return console.log.calls
      .allArgs()
      .map((args) => args.join(" "))
      .filter((line) => line.includes("live lag_ms="));
  }

  beforeEach(function () {
    spyOn(console, "log");
  });

  it("logs how long after the source's change a file went live", async function () {
    const blogID = this.blog.id;
    const modified = Date.now() - 5000;

    await sync(blogID, async function (folder) {
      await storage.write(blogID, "/a.txt", "Hello");
      await folder.update("/a.txt", { modified, since: "test" });
    });

    const lines = lagLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("/a.txt");

    const [, lag] = /live lag_ms=(\d+) since=test/.exec(lines[0]);
    expect(Number(lag)).toBeGreaterThanOrEqual(5000);
  });

  it("reads an ISO string as the source's time", async function () {
    const blogID = this.blog.id;

    await sync(blogID, async function (folder) {
      await storage.write(blogID, "/a.txt", "Hello");
      await folder.update("/a.txt", {
        modified: new Date(Date.now() - 2000).toISOString(),
        since: "test",
      });
    });

    const [, lag] = /live lag_ms=(\d+)/.exec(lagLines()[0]);
    expect(Number(lag)).toBeGreaterThanOrEqual(2000);
  });

  it("logs nothing when the client passes no time", async function () {
    const blogID = this.blog.id;

    await sync(blogID, async function (folder) {
      await storage.write(blogID, "/a.txt", "Hello");
      await folder.update("/a.txt");
    });

    expect(lagLines()).toEqual([]);
  });

  // An unchanged file did not go live: nothing new is on the site
  it("logs nothing when the update changed nothing", async function () {
    const blogID = this.blog.id;

    await sync(blogID, async function (folder) {
      await storage.write(blogID, "/a.txt", "Hello");
      await folder.update("/a.txt");
    });

    await sync(blogID, async function (folder) {
      await folder.update("/a.txt", { modified: Date.now(), since: "test" });
    });

    expect(lagLines()).toEqual([]);
  });

  it("ignores a time it can't read", async function () {
    const blogID = this.blog.id;

    await sync(blogID, async function (folder) {
      await storage.write(blogID, "/a.txt", "Hello");
      await folder.update("/a.txt", { modified: "not a date" });
    });

    expect(lagLines()).toEqual([]);
  });

  it("logs where the time went", async function () {
    const blogID = this.blog.id;
    const modified = Date.now() - 5000;

    await sync(blogID, async function (folder) {
      await storage.write(blogID, "/a.txt", "Hello");
      await folder.update("/a.txt", {
        modified,
        since: "test",
        seenAt: modified + 1000,
        seenBy: "changes",
        downloadedAt: modified + 3000,
      });
    });

    const line = lagLines()[0];
    expect(line).toContain("seen_ms=1000 seen_by=changes");
    expect(line).toContain("download_ms=3000");
    const [, lock] = /lock_ms=(-?\d+)/.exec(line);
    expect(Number(lock)).toBeGreaterThanOrEqual(5000);
    expect(line).toMatch(/build_ms=\d+/);
  });

  it("leaves out the stages the client didn't pass", async function () {
    const blogID = this.blog.id;

    await sync(blogID, async function (folder) {
      await storage.write(blogID, "/a.txt", "Hello");
      await folder.update("/a.txt", { modified: Date.now(), since: "test" });
    });

    const line = lagLines()[0];
    expect(line).not.toContain("seen_ms=");
    expect(line).not.toContain("download_ms=");
    expect(line).toContain("lock_ms=");
  });
});
