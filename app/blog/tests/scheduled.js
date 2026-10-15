describe("scheduled entries", function () {
  require("./util/setup")();

  global.test.timeout(20 * 1000);

  const client = require("models/client");
  const scheduled = require("models/entry/scheduled");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  afterEach(async function () {
    // Only this spec's alarm: other specs may share the keys
    const id = scheduled.toID(this.blog.id, "/scheduled.txt");
    await client.zRem("alarm:due:scheduled-entries", id);
    await client.hDel("alarm:claims:scheduled-entries", id);
  });

  it("promotes a scheduled entry once its publication time arrives", async function () {
    const publishAt = Date.now() + 2000;

    await this.write({
      path: "/scheduled.txt",
      content:
        "Link: a\nDate: " + new Date(publishAt).toISOString() + "\n\nHello, future!",
    });

    // Not published while its time is still in the future
    const before = await this.get("/a");
    expect(before.status).toEqual(404);

    while (Date.now() <= publishAt) await sleep(100);

    // The alarm is normally polled every few seconds by each process
    await scheduled.alarm.poll();

    // Publishing re-saves the entry and bumps the blog's cache ID; poll the
    // live endpoint until the entry is served.
    const start = Date.now();
    let res = await this.get("/a");

    while (res.status !== 200 && Date.now() - start < 10 * 1000) {
      await sleep(100);
      res = await this.get("/a");
    }

    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body).toContain("Hello, future!");
  });
});
