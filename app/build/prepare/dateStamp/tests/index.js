const dateStamp = require("..");

describe("dateStamp", function () {
  it("reads Date metadata with mixed-case key", function () {
    const blog = { id: "test", dateFormat: "M/D/YYYY", timeZone: "Etc/UTC" };
    const metadata = { Date: "2019-04-03 12:33:15" };

    expect(dateStamp(blog, "/post.txt", metadata)).toEqual(1554294795000);
  });

  describe("using the time from the entry's creation date", function () {
    const blog = { id: "test", dateFormat: "M/D/YYYY", timeZone: "Etc/UTC" };

    it("uses the time of day from previousCreated when the metadata date has no time and falls on the same day", function () {
      const metadata = { Date: "12/12/2025" };
      // 2025-12-12 15:30:00 UTC
      const previousCreated = Date.UTC(2025, 11, 12, 15, 30, 0);

      expect(dateStamp(blog, "/post.txt", metadata, previousCreated)).toEqual(
        Date.UTC(2025, 11, 12, 15, 30, 0)
      );
    });

    it("leaves the date at midnight when there is no previousCreated", function () {
      const metadata = { Date: "12/12/2025" };

      expect(dateStamp(blog, "/post.txt", metadata)).toEqual(
        Date.UTC(2025, 11, 12, 0, 0, 0)
      );
    });

    it("leaves the date at midnight when previousCreated falls on a different day", function () {
      const metadata = { Date: "12/12/2025" };
      // Entry was first created a day earlier - the metadata date was
      // likely edited after the fact, so don't graft on an unrelated time.
      const previousCreated = Date.UTC(2025, 11, 11, 15, 30, 0);

      expect(dateStamp(blog, "/post.txt", metadata, previousCreated)).toEqual(
        Date.UTC(2025, 11, 12, 0, 0, 0)
      );
    });

    it("does not override a time explicitly set in the metadata", function () {
      const metadata = { Date: "2025-12-12 09:15" };
      const previousCreated = Date.UTC(2025, 11, 12, 15, 30, 0);

      expect(dateStamp(blog, "/post.txt", metadata, previousCreated)).toEqual(
        Date.UTC(2025, 11, 12, 9, 15, 0)
      );
    });

    it("falls back to path/undefined when the date metadata is removed, ignoring previousCreated", function () {
      const previousCreated = Date.UTC(2025, 11, 12, 15, 30, 0);

      expect(dateStamp(blog, "/post.txt", {}, previousCreated)).toEqual(
        undefined
      );
    });

    it("applies the same time-of-day logic to a date extracted from the file's path", function () {
      const previousCreated = Date.UTC(2025, 11, 12, 15, 30, 0);

      expect(
        dateStamp(blog, "/2025/12/12/post.txt", {}, previousCreated)
      ).toEqual(Date.UTC(2025, 11, 12, 15, 30, 0));
    });

    it("leaves a path-derived date at midnight when previousCreated is a different day", function () {
      const previousCreated = Date.UTC(2025, 11, 11, 15, 30, 0);

      expect(
        dateStamp(blog, "/2025/12/12/post.txt", {}, previousCreated)
      ).toEqual(Date.UTC(2025, 11, 12, 0, 0, 0));
    });

    it("does not override a time already encoded in the path", function () {
      const previousCreated = Date.UTC(2025, 11, 12, 15, 30, 0);

      expect(
        dateStamp(blog, "/2025/12/12/09/45/post.txt", {}, previousCreated)
      ).toEqual(Date.UTC(2025, 11, 12, 9, 45, 0));
    });

    it("applies the same time-of-day logic to a date parsed from YAML front matter", function () {
      const Metadata = require("build/metadata");
      const { metadata } = Metadata(
        "---\ndate: 12/12/2025\ntitle: Hello\n---\nBody text"
      );
      const previousCreated = Date.UTC(2025, 11, 12, 15, 30, 0);

      expect(dateStamp(blog, "/post.txt", metadata, previousCreated)).toEqual(
        Date.UTC(2025, 11, 12, 15, 30, 0)
      );
    });

    it("does not override a time already encoded in YAML front matter", function () {
      const Metadata = require("build/metadata");
      const { metadata } = Metadata(
        "---\ndate: 2025-12-12T09:15:00Z\ntitle: Hello\n---\nBody text"
      );
      const previousCreated = Date.UTC(2025, 11, 12, 15, 30, 0);

      expect(dateStamp(blog, "/post.txt", metadata, previousCreated)).toEqual(
        Date.UTC(2025, 11, 12, 9, 15, 0)
      );
    });

    it("returns the exact previousCreated instant across a DST fall-back transition", function () {
      const moment = require("moment-timezone");
      const blogNY = {
        id: "test",
        dateFormat: "M/D/YYYY",
        timeZone: "America/New_York",
      };
      const metadata = { Date: "11/2/2025" };

      // Clocks in America/New_York fall back from 2am to 1am on this date,
      // so 01:30 local occurs twice - once at UTC-4 (EDT), once at UTC-5
      // (EST). previousCreated pins the exact instant of the *second*
      // occurrence (EST); reconstructing a timestamp from wall-clock
      // fields alone could silently pick the first (EDT) instead.
      const previousCreated = moment
        .tz("2025-11-02 01:30", "America/New_York")
        .valueOf();

      expect(dateStamp(blogNY, "/post.txt", metadata, previousCreated)).toEqual(
        previousCreated
      );
    });

    it("matches the metadata date to the entry's creation day even when the timezone offset differs at UTC midnight", function () {
      const moment = require("moment-timezone");
      const blogSantiago = {
        id: "test",
        dateFormat: "M/D/YYYY",
        timeZone: "America/Santiago",
      };
      const metadata = { Date: "4/7/2024" };

      // UTC midnight on April 7th is already April 6th evening in
      // America/Santiago, so adjustByBlogTimezone's UTC-midnight-relative
      // offset lands the adjusted timestamp on April 6th local time. The
      // comparison must still recognise this entry, created during April
      // 7th local time, as being on the metadata's intended day.
      const previousCreated = moment
        .tz("2024-04-07 10:00", "America/Santiago")
        .valueOf();

      expect(
        dateStamp(blogSantiago, "/post.txt", metadata, previousCreated)
      ).toEqual(previousCreated);
    });

    it("does not override an explicit time whose minutes are a single digit", function () {
      const metadata = { Date: "12/12/2025 9:5" };
      const previousCreated = Date.UTC(2025, 11, 12, 15, 30, 0);

      expect(dateStamp(blog, "/post.txt", metadata, previousCreated)).toEqual(
        Date.UTC(2025, 11, 12, 9, 5, 0)
      );
    });
  });
});
