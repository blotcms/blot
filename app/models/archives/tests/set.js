describe("archives.set", function () {
  const set = require("../set");
  const list = require("../list");

  global.test.blog();

  it("adds a visible entry to its month bucket", function (done) {
    const entry = {
      id: "entry1",
      path: "/entry1",
      dateStamp: Date.parse("2020-01-15T00:00:00Z"),
    };

    set(this.blog.id, entry, "UTC", async (err) => {
      if (err) return done.fail(err);

      const months = await list.months(this.blog.id);
      expect(months).toEqual([{ yearMonth: "2020-01", count: 1 }]);

      const ids = await list.bucket(this.blog.id, "2020-01");
      expect(ids).toEqual(["entry1"]);
      done();
    });
  });

  ["page", "menu", "draft", "scheduled", "deleted"].forEach(function (
    property
  ) {
    it("does not index a " + property + " entry", function (done) {
      const entry = {
        id: property + "-entry",
        path: "/" + property + "-entry",
        dateStamp: Date.parse("2020-01-15T00:00:00Z"),
      };
      entry[property] = true;

      set(this.blog.id, entry, "UTC", async (err) => {
        if (err) return done.fail(err);

        const months = await list.months(this.blog.id);
        expect(months).toEqual([]);
        done();
      });
    });
  });

  it("does not index an entry with no dateStamp", function (done) {
    const entry = {
      id: "no-datestamp-entry",
      path: "/no-datestamp-entry",
      dateStamp: undefined,
    };

    set(this.blog.id, entry, "UTC", async (err) => {
      if (err) return done.fail(err);

      const months = await list.months(this.blog.id);
      expect(months).toEqual([]);
      done();
    });
  });

  it("removes an entry from its bucket if a later save clears its dateStamp", function (done) {
    const entry = {
      id: "entry1",
      path: "/entry1",
      dateStamp: Date.parse("2020-01-15T00:00:00Z"),
    };

    set(this.blog.id, entry, "UTC", (err) => {
      if (err) return done.fail(err);

      entry.dateStamp = undefined;

      set(this.blog.id, entry, "UTC", async (err) => {
        if (err) return done.fail(err);

        const months = await list.months(this.blog.id);
        expect(months).toEqual([]);
        done();
      });
    });
  });

  it("moves an entry between months when its dateStamp changes", function (done) {
    const entry = {
      id: "entry1",
      path: "/entry1",
      dateStamp: Date.parse("2020-01-15T00:00:00Z"),
    };

    set(this.blog.id, entry, "UTC", (err) => {
      if (err) return done.fail(err);

      entry.dateStamp = Date.parse("2020-03-01T00:00:00Z");

      set(this.blog.id, entry, "UTC", async (err) => {
        if (err) return done.fail(err);

        const months = await list.months(this.blog.id);
        expect(months).toEqual([{ yearMonth: "2020-03", count: 1 }]);

        const oldBucket = await list.bucket(this.blog.id, "2020-01");
        expect(oldBucket).toEqual([]);
        done();
      });
    });
  });

  it("refreshes the score without moving buckets for a same-month dateStamp change", function (done) {
    const entry = {
      id: "entry1",
      path: "/entry1",
      dateStamp: Date.parse("2020-01-05T00:00:00Z"),
    };

    set(this.blog.id, entry, "UTC", (err) => {
      if (err) return done.fail(err);

      entry.dateStamp = Date.parse("2020-01-25T00:00:00Z");

      set(this.blog.id, entry, "UTC", async (err) => {
        if (err) return done.fail(err);

        const months = await list.months(this.blog.id);
        expect(months).toEqual([{ yearMonth: "2020-01", count: 1 }]);
        done();
      });
    });
  });

  it("removes an entry from its bucket when it becomes a draft", function (done) {
    const entry = {
      id: "entry1",
      path: "/entry1",
      dateStamp: Date.parse("2020-01-15T00:00:00Z"),
    };

    set(this.blog.id, entry, "UTC", (err) => {
      if (err) return done.fail(err);

      entry.draft = true;

      set(this.blog.id, entry, "UTC", async (err) => {
        if (err) return done.fail(err);

        const months = await list.months(this.blog.id);
        expect(months).toEqual([]);
        done();
      });
    });
  });

  it("prunes a month once its last entry moves away", function (done) {
    const entry = {
      id: "entry1",
      path: "/entry1",
      dateStamp: Date.parse("2020-01-15T00:00:00Z"),
    };
    const other = {
      id: "entry2",
      path: "/entry2",
      dateStamp: Date.parse("2020-02-15T00:00:00Z"),
    };

    set(this.blog.id, entry, "UTC", (err) => {
      if (err) return done.fail(err);

      set(this.blog.id, other, "UTC", (err) => {
        if (err) return done.fail(err);

        entry.dateStamp = Date.parse("2020-02-20T00:00:00Z");

        set(this.blog.id, entry, "UTC", async (err) => {
          if (err) return done.fail(err);

          const months = await list.months(this.blog.id);
          expect(months).toEqual([{ yearMonth: "2020-02", count: 2 }]);
          done();
        });
      });
    });
  });

  it("buckets by the blog's timezone, not UTC", function (done) {
    // 2020-01-01T00:30 UTC is still 2019-12-31 in America/Los_Angeles (UTC-8).
    const entry = {
      id: "entry1",
      path: "/entry1",
      dateStamp: Date.parse("2020-01-01T00:30:00Z"),
    };

    set(this.blog.id, entry, "America/Los_Angeles", async (err) => {
      if (err) return done.fail(err);

      const months = await list.months(this.blog.id);
      expect(months).toEqual([{ yearMonth: "2019-12", count: 1 }]);
      done();
    });
  });
});
