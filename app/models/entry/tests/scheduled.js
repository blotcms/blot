describe("entry scheduled publication", function () {
  require("./setup")();

  global.test.timeout(30 * 1000);

  const client = require("models/client");
  const scheduled = require("../scheduled");
  const alarms = scheduled.alarm;

  const DUE = "alarm:due:scheduled-entries";
  const CLAIMS = "alarm:claims:scheduled-entries";
  const DAY = 24 * 60 * 60 * 1000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(function () {
    this.ids = [];
    this.id = (path) => {
      const id = scheduled.toID(this.blog.id, path);
      this.ids.push(id);
      return id;
    };
    this.future = (ms) => new Date(Date.now() + ms).toISOString();
  });

  // Only this spec's ids: other specs may share the alarm keys
  afterEach(async function () {
    for (const id of this.ids) {
      await client.zRem(DUE, id);
      await client.hDel(CLAIMS, id);
    }
  });

  it("sets the alarm at the dateStamp of a scheduled entry", async function () {
    const id = this.id("/future.txt");
    const entry = await this.set(
      "/future.txt",
      "Date: " + this.future(DAY) + "\n\nHello"
    );

    expect(entry.scheduled).toBe(true);
    expect(await alarms.when(id)).toEqual(entry.dateStamp);
  });

  it("leaves the alarm alone when the date moves to the past", async function () {
    const id = this.id("/future.txt");
    await this.set("/future.txt", "Date: " + this.future(DAY) + "\n\nHello");
    expect(await alarms.when(id)).not.toBe(null);

    const entry = await this.set("/future.txt", "Date: 2020-01-01\n\nHello");

    // Published by this save, but only the alarm handler completes (removes)
    // the alarm, after the whole publication
    expect(entry.scheduled).toBe(false);
    expect(await alarms.when(id)).not.toBe(null);
  });

  it("removes the alarm when the handler publishes a due entry", async function () {
    const id = this.id("/due.txt");
    await this.set("/due.txt", "Date: " + this.future(1500) + "\n\nHello");
    await sleep(2000);
    expect(await alarms.when(id)).not.toBe(null);

    await alarms.poll();

    expect((await this.get("/due.txt")).scheduled).toBe(false);
    expect(await alarms.when(id)).toBe(null);
  });

  it("cancels the alarm when the entry becomes a draft", async function () {
    const id = this.id("/future.txt");
    await this.set("/future.txt", "Date: " + this.future(DAY) + "\n\nHello");
    expect(await alarms.when(id)).not.toBe(null);

    const set = require("../set");
    await new Promise((resolve, reject) =>
      set(this.blog.id, "/future.txt", { draft: true }, (err) =>
        err ? reject(err) : resolve()
      )
    );

    expect(await alarms.when(id)).toBe(null);
  });

  it("cancels the alarm when the entry is deleted", async function () {
    const id = this.id("/future.txt");
    await this.set("/future.txt", "Date: " + this.future(DAY) + "\n\nHello");
    expect(await alarms.when(id)).not.toBe(null);

    await this.drop("/future.txt");

    expect(await alarms.when(id)).toBe(null);
  });

  it("cancels the alarm when the entry is dropped", async function () {
    const id = this.id("/future.txt");
    await this.set("/future.txt", "Date: " + this.future(DAY) + "\n\nHello");
    expect(await alarms.when(id)).not.toBe(null);

    await this.drop("/future.txt");

    expect(await alarms.when(id)).toBe(null);
  });

  it("round-trips an id whose path contains colons", async function () {
    const id = this.id("/a:b/c:d.txt");

    expect(scheduled.fromID(id)).toEqual({
      blogID: this.blog.id,
      path: "/a:b/c:d.txt",
    });
  });

  it("publishes a due entry when the alarm is polled", async function () {
    const id = this.id("/soon.txt");
    await this.set("/soon.txt", "Date: " + this.future(1500) + "\n\nHello");
    expect((await this.get("/soon.txt")).scheduled).toBe(true);

    await sleep(2000);
    await alarms.poll();

    const entry = await this.get("/soon.txt");
    expect(entry.scheduled).toBe(false);
    expect(await alarms.when(id)).toBe(null);
  });

  it("re-arms the alarm for the new date if the entry was rescheduled", async function () {
    const id = this.id("/later.txt");
    const entry = await this.set(
      "/later.txt",
      "Date: " + this.future(DAY) + "\n\nHello"
    );

    // A stale alarm that fires early
    await alarms.set(id, Date.now() - 1000);
    await alarms.poll();

    expect((await this.get("/later.txt")).scheduled).toBe(true);
    expect(await alarms.when(id)).toEqual(entry.dateStamp);
  });

  it("ignores an alarm for an entry that no longer exists", async function () {
    const id = this.id("/missing.txt");

    await alarms.set(id, Date.now() - 1000);
    await alarms.poll();

    expect(await alarms.when(id)).toBe(null);
  });

  // The handler requires ./get on each run, so swapping the cached export
  // changes what it reads without touching the real entry
  async function withGetter(fake, fn) {
    const path = require.resolve("../get");
    const original = require.cache[path].exports;
    require.cache[path].exports = fake;
    try {
      await fn();
    } finally {
      require.cache[path].exports = original;
    }
  }

  it("keeps the alarm if publishing fails after the re-save", async function () {
    const id = this.id("/flaky.txt");
    await this.set("/flaky.txt", "Date: " + this.future(1500) + "\n\nHello");
    await sleep(2000);

    const Blog = require("models/blog");
    const bump = Blog.bumpCacheID;
    let failed = false;
    spyOn(Blog, "bumpCacheID").and.callFake(function (blogID, callback) {
      if (!failed) {
        failed = true;
        return callback(new Error("boom"));
      }
      return bump.call(Blog, blogID, callback);
    });

    const retryMs = scheduled.RETRY_MS;
    scheduled.RETRY_MS = 200;

    try {
      await alarms.poll();

      expect(failed).toBe(true);
      expect(await alarms.when(id)).not.toBe(null);

      await sleep(300);
      await alarms.poll();
    } finally {
      scheduled.RETRY_MS = retryMs;
    }

    // The retry finishes the publication even though the first re-save had
    // already marked the entry unscheduled
    expect(Blog.bumpCacheID.calls.count()).toEqual(2);
    expect((await this.get("/flaky.txt")).scheduled).toBe(false);
    expect(await alarms.when(id)).toBe(null);
  });

  it("keeps the alarm if the entry cannot be read", async function () {
    const id = this.id("/unreadable.txt");
    await alarms.set(id, Date.now() - 1000);

    await withGetter(
      (blogID, path, callback) => callback(undefined, new Error("boom")),
      () => alarms.poll()
    );

    expect(await alarms.when(id)).not.toBe(null);
  });

  it("does not overwrite a newer reschedule that lands mid-handling", async function () {
    const id = this.id("/moving.txt");
    const d1 = Date.now() + DAY;
    const d2 = Date.now() + 2 * DAY;
    const reads = [d1, d2];

    await alarms.set(id, Date.now() - 1000);

    await withGetter(
      (blogID, path, callback) =>
        callback({ scheduled: true, dateStamp: reads.length > 1 ? reads.shift() : reads[0] }),
      () => alarms.poll()
    );

    expect(await alarms.when(id)).toEqual(d2);
  });

  describe("reconcile", function () {
    it("sets the alarm of a scheduled entry that has none", async function () {
      const id = this.id("/missing.txt");
      const entry = await this.set(
        "/missing.txt",
        "Date: " + this.future(DAY) + "\n\nHello"
      );
      await alarms.cancel(id);

      const counts = await scheduled.reconcile();

      expect(counts.failed).toEqual(0);
      expect(counts.set).toBeGreaterThan(0);
      expect(await alarms.when(id)).toEqual(entry.dateStamp);
    });

    it("corrects an alarm at the wrong time", async function () {
      const id = this.id("/wrong.txt");
      const entry = await this.set(
        "/wrong.txt",
        "Date: " + this.future(DAY) + "\n\nHello"
      );
      await alarms.set(id, entry.dateStamp + DAY);

      await scheduled.reconcile();

      expect(await alarms.when(id)).toEqual(entry.dateStamp);
    });

    it("leaves a correct alarm untouched", async function () {
      const id = this.id("/right.txt");
      const entry = await this.set(
        "/right.txt",
        "Date: " + this.future(DAY) + "\n\nHello"
      );
      spyOn(alarms, "set").and.callThrough();

      await scheduled.reconcile();

      expect(alarms.set).not.toHaveBeenCalledWith(id, jasmine.anything());
      expect(await alarms.when(id)).toEqual(entry.dateStamp);
    });

    it("ignores a published entry", async function () {
      const id = this.id("/published.txt");
      await this.set("/published.txt", "Date: 2020-01-01\n\nHello");

      await scheduled.reconcile();

      expect(await alarms.when(id)).toBe(null);
    });
  });
});
