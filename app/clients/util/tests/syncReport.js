describe("clients/util syncReport", function () {
  const syncReport = require("../syncReport");
  const lockPath = require.resolve("sync/lock");

  const blog = { id: "blog_0123456789abcdef", handle: "example" };
  const other = { id: "blog_fedcba9876543210", handle: "other" };

  it("has no issues until something is recorded for a blog", function () {
    const report = syncReport.create();

    syncReport.recordChanges(report, blog, { downloaded: 0 });
    syncReport.recordFix(report, blog, {});

    expect(syncReport.hasIssues(report)).toEqual(false);
    expect(syncReport.view(report)).toEqual({ blogs: [] });
  });

  it("records changes with their breakdown", function () {
    const report = syncReport.create();

    syncReport.recordChanges(report, blog, {
      downloaded: 3,
      removed: 1,
      createdDirs: 1,
      modifiedDuringWalk: 1,
    });

    const [record] = syncReport.view(report).blogs;
    expect(record.id).toEqual(blog.id);
    expect(record.handle).toEqual("example");
    expect(record.truncatedId).toEqual("blog_0123456");
    expect(record.hasChanges).toEqual(true);
    expect(record.changeCount).toEqual(4);
    expect(record.changeCountPlural).toEqual(true);
    expect(record.downloaded).toEqual(3);
    expect(record.removed).toEqual(1);
    expect(record.createdDirs).toEqual(1);
    expect(record.modifiedDuringWalk).toEqual(1);
  });

  it("does not count changes made during the walk", function () {
    const report = syncReport.create();

    syncReport.recordChanges(report, blog, {
      downloaded: 1,
      modifiedDuringWalk: 1,
    });

    expect(syncReport.hasIssues(report)).toEqual(false);
  });

  it("formats Fix() reports with up to 10 samples and a more count", function () {
    const checks = syncReport.formatFix({
      "entry-ghosts": [{ id: 1 }],
      "tag-ghosts": Array.from({ length: 12 }, (_, i) => i),
    });

    expect(checks[0]).toEqual({
      name: "entry-ghosts",
      count: 1,
      countPlural: false,
      sample: ['{"id":1}'],
      moreCount: 0,
      hasMore: false,
    });
    expect(checks[1].count).toEqual(12);
    expect(checks[1].countPlural).toEqual(true);
    expect(checks[1].sample.length).toEqual(10);
    expect(checks[1].moreCount).toEqual(2);
    expect(checks[1].hasMore).toEqual(true);
    expect(syncReport.formatFix(undefined)).toEqual([]);
  });

  it("records a Fix() report and an error as issues, keeping blogs separate", function () {
    const report = syncReport.create();

    syncReport.recordFix(report, blog, { "list-ghosts": ["a"] });
    syncReport.recordError(report, other, "catch-up sync", new Error("nope"));
    syncReport.recordChanges(report, other, {});

    const [first, second] = syncReport.view(report).blogs;
    expect(first.hasRepairs).toEqual(true);
    expect(first.hasErrors).toEqual(false);
    expect(second.hasRepairs).toEqual(false);
    expect(second.hasErrors).toEqual(true);
    expect(second.errors).toEqual([{ phase: "catch-up sync", message: "nope" }]);
  });

  it("truncates long error messages", function () {
    const report = syncReport.create();

    syncReport.recordError(report, blog, "walk", new Error("x".repeat(1000)));

    const message = syncReport.view(report).blogs[0].errors[0].message;
    expect(message.length).toBeLessThan(400);
  });

  it("summarizes a Fix() report on one line", function () {
    expect(syncReport.summarize({ a: [1, 2, 3], b: [1] })).toEqual("a=3 b=1");
    expect(syncReport.summarize({})).toEqual("");
    expect(syncReport.summarize(undefined)).toEqual("");
  });

  describe("send", function () {
    it("does not send when there are no issues", function () {
      const report = syncReport.create();
      const sent = [];

      syncReport.recordChanges(report, blog, {});
      syncReport.send(report, () => sent.push(1), "Test:");

      expect(sent.length).toEqual(0);
    });

    it("sends the view through the given email function", function () {
      const report = syncReport.create();
      const sent = [];

      syncReport.recordError(report, blog, "walk", new Error("boom"));
      syncReport.send(
        report,
        function (uid, locals, callback) {
          sent.push({ uid, locals });
          callback();
        },
        "Test:"
      );

      expect(sent.length).toEqual(1);
      expect(sent[0].uid).toBeNull();
      expect(sent[0].locals.blogs[0].errors[0].phase).toEqual("walk");
    });

    it("sends through a template name on helper/email", function () {
      const email = require("helper/email");
      const report = syncReport.create();
      const sent = [];

      spyOn(email, "DROPBOX_SYNC_ISSUE").and.callFake(function (uid, locals, cb) {
        sent.push(locals);
        cb();
      });
      syncReport.recordError(report, blog, "walk", new Error("boom"));
      syncReport.send(report, "DROPBOX_SYNC_ISSUE", "Test:");

      expect(sent.length).toEqual(1);
    });

    it("does not throw when the send fails", function () {
      const report = syncReport.create();

      spyOn(console, "error");
      syncReport.recordError(report, blog, "walk", new Error("boom"));
      syncReport.send(report, (uid, locals, cb) => cb(new Error("mailgun")), "Test:");

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("recordBusy", function () {
    let original;

    beforeEach(function () {
      original = require.cache[lockPath];
    });

    afterEach(function () {
      if (original) require.cache[lockPath] = original;
      else delete require.cache[lockPath];
    });

    function stubHeldSince(value) {
      require.cache[lockPath] = {
        id: lockPath,
        filename: lockPath,
        loaded: true,
        exports: {
          heldSince: () =>
            value instanceof Error ? Promise.reject(value) : Promise.resolve(value),
        },
      };
    }

    const MINUTE = 60 * 1000;

    it("reports a lock held longer than the threshold", async function () {
      const report = syncReport.create();
      stubHeldSince(Date.now() - 135 * MINUTE);

      expect(await syncReport.recordBusy(report, blog)).toEqual(true);

      const [record] = syncReport.view(report).blogs;
      expect(record.hasStuckLock).toEqual(true);
      expect(record.lockHeldFor).toEqual("2h 15m");
    });

    it("stays a silent skip for a recently taken lock", async function () {
      const report = syncReport.create();
      stubHeldSince(Date.now() - syncReport.STUCK_LOCK_THRESHOLD_MS + 5 * MINUTE);

      expect(await syncReport.recordBusy(report, blog)).toEqual(false);
      expect(syncReport.hasIssues(report)).toEqual(false);
    });

    it("stays a silent skip when the lock age is unknown or unreadable", async function () {
      const report = syncReport.create();

      stubHeldSince(null);
      expect(await syncReport.recordBusy(report, blog)).toEqual(false);

      spyOn(console, "error");
      stubHeldSince(new Error("redis down"));
      expect(await syncReport.recordBusy(report, blog)).toEqual(false);

      expect(syncReport.hasIssues(report)).toEqual(false);
    });
  });
});
