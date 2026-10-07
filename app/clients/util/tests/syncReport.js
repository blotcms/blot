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


  it("records a walk with skipped files as a walk error plus its changes", function () {
    const report = syncReport.create();

    expect(
      syncReport.recordWalk(report, blog, { downloaded: 2, failed: 0 })
    ).toEqual(true);
    expect(
      syncReport.recordWalk(report, other, {
        downloaded: 1,
        failed: 3,
        firstError: "/a.txt: boom",
      })
    ).toEqual(false);

    const [first, second] = syncReport.view(report).blogs;
    expect(first.hasErrors).toEqual(false);
    expect(second.changeCount).toEqual(1);
    expect(second.errors).toEqual([
      { phase: "walk", message: "3 file(s) failed to sync, eg. /a.txt: boom" },
    ]);
  });

  it("totals the live edits it excluded from the change count", function () {
    const [record] = (function () {
      const report = syncReport.create();
      syncReport.recordChanges(report, blog, {
        downloaded: 3,
        removed: 1,
        modifiedDuringWalk: 2,
        changedDuringWalk: 1,
      });
      return syncReport.view(report).blogs;
    })();

    expect(record.changeCount).toEqual(1);
    expect(record.excluded).toEqual(3);
  });

  describe("send", function () {
    it("does not send when there are no issues", async function () {
      const report = syncReport.create();
      const sent = [];

      syncReport.recordChanges(report, blog, {});
      expect(await syncReport.send(report, () => sent.push(1), "Test:")).toEqual(0);

      expect(sent.length).toEqual(0);
    });

    it("sends the view through the given email function", async function () {
      const report = syncReport.create();
      const sent = [];

      syncReport.recordError(report, blog, "walk", new Error("boom"));
      const listed = await syncReport.send(
        report,
        function (uid, locals, callback) {
          sent.push({ uid, locals });
          callback();
        },
        "Test:"
      );

      expect(listed).toEqual(1);
      expect(sent.length).toEqual(1);
      expect(sent[0].uid).toBeNull();
      expect(sent[0].locals.blogs[0].errors[0].phase).toEqual("walk");
    });

    it("sends through a template name on helper/email", async function () {
      const email = require("helper/email");
      const report = syncReport.create();
      const sent = [];

      spyOn(email, "DROPBOX_SYNC_ISSUE").and.callFake(function (uid, locals, cb) {
        sent.push(locals);
        cb();
      });
      syncReport.recordError(report, blog, "walk", new Error("boom"));
      await syncReport.send(report, "DROPBOX_SYNC_ISSUE", "Test:");

      expect(sent.length).toEqual(1);
    });

    it("does not throw when the send fails", async function () {
      const report = syncReport.create();

      spyOn(console, "error");
      syncReport.recordError(report, blog, "walk", new Error("boom"));
      await syncReport.send(report, (uid, locals, cb) => cb(new Error("mailgun")), "Test:");

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("stuck locks", function () {
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

      expect(await syncReport.recordStuckLock(report, blog)).toEqual(true);

      const [record] = syncReport.view(report).blogs;
      expect(record.hasStuckLock).toEqual(true);
      expect(record.lockHeldFor).toEqual("2h 15m");
    });

    it("stays silent for a recently taken lock", async function () {
      const report = syncReport.create();
      stubHeldSince(Date.now() - syncReport.STUCK_LOCK_THRESHOLD_MS + 5 * MINUTE);

      expect(await syncReport.recordStuckLock(report, blog)).toEqual(false);
      expect(syncReport.hasIssues(report)).toEqual(false);
    });

    it("stays silent when the lock age is unknown or unreadable", async function () {
      const report = syncReport.create();

      stubHeldSince(null);
      expect(await syncReport.recordStuckLock(report, blog)).toEqual(false);

      spyOn(console, "error");
      stubHeldSince(new Error("redis down"));
      expect(await syncReport.recordStuckLock(report, blog)).toEqual(false);

      expect(syncReport.hasIssues(report)).toEqual(false);
    });
  });

  describe("user-side health", function () {
    const health = require("clients/health");

    it("treats revoked access, a missing folder and full storage as user-side", async function () {
      for (const code of [
        health.CODES.REAUTH_REQUIRED,
        health.CODES.SOURCE_MISSING,
        health.CODES.QUOTA_EXCEEDED,
      ]) {
        const getHealth = async () => health.error([{ code }]);
        expect(await syncReport.hasUserSideIssue(blog.id, getHealth)).toEqual(true);
      }
    });

    it("does not treat Blot's own failures or a healthy blog as user-side", async function () {
      for (const result of [
        health.ok(),
        health.syncing(),
        health.error([{ code: health.CODES.TRANSFER_INCOMPLETE }]),
        health.error([{ code: health.CODES.SYNC_ERROR }]),
      ]) {
        expect(await syncReport.hasUserSideIssue(blog.id, async () => result)).toEqual(
          false
        );
      }
    });

    it("answers false, and logs, when the health lookup fails", async function () {
      spyOn(console, "error");

      const result = await syncReport.hasUserSideIssue(blog.id, async () => {
        throw new Error("redis down");
      });

      expect(result).toEqual(false);
      expect(console.error).toHaveBeenCalled();
    });

    it("drops a blog whose folder was deleted during the walk before sending", async function () {
      const report = syncReport.create();
      const sent = [];
      const states = {
        [blog.id]: health.error([{ code: health.CODES.SOURCE_MISSING }]),
        [other.id]: health.ok(),
      };

      syncReport.recordError(report, blog, "walk", new Error("folder not found"));
      syncReport.recordChanges(report, blog, { removed: 4 });
      syncReport.recordError(report, other, "walk", new Error("boom"));

      const listed = await syncReport.send(
        report,
        (uid, locals, cb) => {
          sent.push(locals);
          cb();
        },
        "Test:",
        { getHealth: async (blogID) => states[blogID] }
      );

      expect(listed).toEqual(1);
      expect(sent[0].blogs.map((record) => record.id)).toEqual([other.id]);
    });

    it("sends nothing when every blog turns out to be user-side", async function () {
      const report = syncReport.create();
      const sent = [];

      syncReport.recordError(report, blog, "walk", new Error("revoked"));
      await syncReport.send(report, () => sent.push(1), "Test:", {
        getHealth: async () => health.error([{ code: health.CODES.REAUTH_REQUIRED }]),
      });

      expect(sent.length).toEqual(0);
    });

    it("still reports a blog when its health lookup fails", async function () {
      const report = syncReport.create();
      const sent = [];

      spyOn(console, "error");
      syncReport.recordError(report, blog, "walk", new Error("boom"));
      await syncReport.send(
        report,
        (uid, locals, cb) => {
          sent.push(locals);
          cb();
        },
        "Test:",
        {
          getHealth: async () => {
            throw new Error("redis down");
          },
        }
      );

      expect(sent.length).toEqual(1);
    });
  });

  // Errors and stuck locks are emailed once per occurrence; changes and
  // Fix() repairs are events and always are.
  describe("once per occurrence", function () {
    const clientPath = require.resolve("models/client");
    const key = "sync:sweep:test:reported";
    let original;
    let stored;
    let redisDown;

    beforeEach(function () {
      original = require.cache[clientPath];
      stored = new Set();
      redisDown = false;

      require.cache[clientPath] = {
        id: clientPath,
        filename: clientPath,
        loaded: true,
        exports: {
          sMembers: async function (name) {
            if (redisDown) throw new Error("redis down");
            expect(name).toEqual(key);
            return Array.from(stored);
          },
          multi: function () {
            const ops = [];
            const multi = {
              del: () => {
                ops.push(() => stored.clear());
                return multi;
              },
              sAdd: (name, ids) => {
                ops.push(() => ids.forEach((id) => stored.add(id)));
                return multi;
              },
              exec: async () => ops.forEach((op) => op()),
            };
            return multi;
          },
        },
      };
    });

    afterEach(function () {
      if (original) require.cache[clientPath] = original;
      else delete require.cache[clientPath];
    });

    // Runs one sweep: the blog errors in its walk and has a stuck lock.
    async function sweep(options) {
      const report = syncReport.create();
      const sent = [];
      options = options || {};

      if (options.error !== false) {
        syncReport.recordError(report, blog, "walk", new Error("boom"));
      }
      if (options.stuck) {
        const locked = require.cache[lockPath];
        require.cache[lockPath] = {
          id: lockPath,
          filename: lockPath,
          loaded: true,
          exports: { heldSince: async () => Date.now() - 2 * 60 * 60 * 1000 },
        };
        await syncReport.recordStuckLock(report, blog);
        if (locked) require.cache[lockPath] = locked;
        else delete require.cache[lockPath];
      }
      if (options.changes) {
        syncReport.recordChanges(report, blog, { downloaded: 2 });
      }

      await syncReport.send(
        report,
        (uid, locals, cb) => {
          sent.push(locals);
          cb();
        },
        "Test:",
        { client: "test" }
      );

      return sent;
    }

    it("emails an error when it first appears, then stays quiet while it continues", async function () {
      expect((await sweep()).length).toEqual(1);
      expect((await sweep()).length).toEqual(0);
      expect((await sweep()).length).toEqual(0);
    });

    it("emails again once the error has cleared and come back", async function () {
      expect((await sweep()).length).toEqual(1);
      expect((await sweep({ error: false })).length).toEqual(0);
      expect(Array.from(stored)).toEqual([]);
      expect((await sweep()).length).toEqual(1);
    });

    it("remembers errors by phase", async function () {
      await sweep();

      const report = syncReport.create();
      const sent = [];
      syncReport.recordError(report, blog, "fix", new Error("different phase"));
      await syncReport.send(report, (u, locals, cb) => (sent.push(locals), cb()), "Test:", {
        client: "test",
      });

      expect(sent.length).toEqual(1);
      expect(Array.from(stored)).toEqual([blog.id + ":error:fix"]);
    });

    it("suppresses a continuing stuck lock the same way", async function () {
      expect((await sweep({ error: false, stuck: true })).length).toEqual(1);
      expect(Array.from(stored)).toEqual([blog.id + ":stuck-lock"]);
      expect((await sweep({ error: false, stuck: true })).length).toEqual(0);
    });

    it("keeps reporting events while their blog's ongoing problem is suppressed", async function () {
      await sweep();

      const sent = await sweep({ changes: true });

      expect(sent.length).toEqual(1);
      const [record] = sent[0].blogs;
      expect(record.hasChanges).toEqual(true);
      expect(record.hasErrors).toEqual(false);
      expect(record.errors).toEqual([]);
      // the suppressed error is still remembered as ongoing
      expect(Array.from(stored)).toEqual([blog.id + ":error:walk"]);
    });

    it("sends the problem again next time if the email failed", async function () {
      const report = syncReport.create();
      spyOn(console, "error");
      syncReport.recordError(report, blog, "walk", new Error("boom"));
      await syncReport.send(report, (u, l, cb) => cb(new Error("mailgun")), "Test:", {
        client: "test",
      });

      expect(Array.from(stored)).toEqual([]);
      expect((await sweep()).length).toEqual(1);
    });

    it("does not suppress when the memory can't be read", async function () {
      redisDown = true;
      spyOn(console, "error");

      expect((await sweep()).length).toEqual(1);
      expect((await sweep()).length).toEqual(1);
    });
  });
});
