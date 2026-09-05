describe("scheduled entries", function () {
  require("./util/setup")();

  global.test.timeout(20 * 1000);

  let now;

  beforeEach(function () {
    now = new Date("2020-01-01T00:00:00Z");
    jasmine.clock().install();
    jasmine.clock().mockDate(now);
  });

  afterEach(function () {
    jasmine.clock().uninstall();
  });

  it("promotes a scheduled entry once its publication time arrives", async function () {
    const publishDelay = 60 * 1000; // 1 minute
    const buffer = 1000; // 1 second
    const futureDate = new Date(now.getTime() + publishDelay).toISOString();

    await this.write({
      path: "/scheduled.txt",
      content: "Link: a\nDate: " + futureDate + "\n\nHello, future!",
    });

    // Advancing the mocked clock fires the publication job synchronously, but
    // the work it kicks off (app/models/entry/_addToSchedule.js: Entry.set
    // re-save -> entry rebuild -> Blog.set cacheID) is a multi-step chain of
    // real Redis/filesystem I/O that the mocked clock does not drive. A single
    // setImmediate is not enough turns for it to finish under CI load, so poll
    // the live endpoint until the entry is served instead.
    jasmine.clock().tick(publishDelay + buffer);

    // process.hrtime stays real while Jasmine's clock (setTimeout + Date) is
    // mocked, so use it to bound the wait.
    const start = process.hrtime.bigint();
    const timeoutMs = 10 * 1000;

    let postPublishRes = await this.get("/a");

    while (
      postPublishRes.status !== 200 &&
      Number(process.hrtime.bigint() - start) / 1e6 < timeoutMs
    ) {
      await new Promise((resolve) => setImmediate(resolve));
      postPublishRes = await this.get("/a");
    }

    const body = await postPublishRes.text();

    expect(postPublishRes.status).toEqual(200);
    expect(body).toContain("Hello, future!");
  });
});
