// Fresh dates: `now` is the build time, invented dates are recency-weighted, ages can be written.
const cheerio = require("cheerio");
const pane = require("../index");
const { formatDate, inventDates, resolveAge, isoNow, parseDate } = require("../lib/format");

const NOW = "2026-09-21T15:30:00";
const ms = (iso) => {
  const t = parseDate(iso);
  return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi);
};
const daysBack = (iso, now = NOW) => (ms(now) - ms(iso)) / 86400000;
const PATHS = ["About.txt", "Animation.gif", "Blot.webloc", "Draft.md", "Fruits", "Fruits/Apple.md", "index.html", "Logo.png", "Notes.md", "Old report.doc", "Photo.jpg", "Plan.gdoc", "Report.docx", "Tasks.org"];

describe("pane isoNow", function () {
  it("writes a date in UTC in the form now takes", function () {
    expect(isoNow(new Date(Date.UTC(2026, 8, 21, 15, 30, 45)))).toBe("2026-09-21T15:30:45");
    expect(isoNow()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
  });
});

describe("pane invented dates", function () {
  const dates = inventDates(PATHS, NOW);

  it("are a pure function of the paths and now", function () {
    expect(inventDates(PATHS, NOW)).toEqual(dates);
    expect(inventDates(PATHS, "2026-09-22T15:30:00")).not.toEqual(dates);
    expect(inventDates([...PATHS].reverse(), NOW)).toEqual(dates); // not of the order they are listed in
  });

  it("are never later than now, and never older than about 18 months", function () {
    for (const iso of Object.values(dates)) {
      expect(daysBack(iso)).toBeGreaterThan(0);
      expect(daysBack(iso)).toBeLessThan(560);
    }
  });

  it("put the newest rows today and yesterday, so the window looks fresh", function () {
    const back = Object.values(dates).map((d) => Math.floor(daysBack(d))).sort((a, b) => a - b);
    expect(dates[Object.keys(dates).find((p) => daysBack(dates[p]) < 0.3)]).toBeDefined(); // one within hours
    expect(parseDate(Object.values(dates).sort().pop()).d).toBe(21); // the newest is today
    expect(back.filter((d) => d <= 6).length).toBeGreaterThanOrEqual(4); // a handful this week
    expect(back.filter((d) => d > 365).length).toBeLessThan(PATHS.length / 2); // not mostly old
  });

  it("give even a two-row window something recent", function () {
    const two = inventDates(["a.md", "b.md"], NOW);
    expect(Math.min(...Object.values(two).map((d) => daysBack(d)))).toBeLessThan(1);
  });

  it("keep today's row on today's date, whatever the time of day", function () {
    for (const now of ["2026-09-21T00:20:00", "2026-09-21T03:00:00", "2026-09-21T23:59:00"]) {
      const d = inventDates(["a.md", "b.md", "c.md"], now);
      const newest = Object.values(d).sort().pop();
      expect(newest.slice(0, 10)).toBe("2026-09-21");
      const second = Object.values(d).sort().slice(-2)[0];
      expect(second.slice(0, 10)).toBe("2026-09-20"); // yesterday
    }
  });
});

describe("pane ages written in the source", function () {
  it("resolve against now", function () {
    expect(resolveAge("3d", NOW)).toBe("2026-09-18T15:30:00");
    expect(resolveAge("2h", NOW)).toBe("2026-09-21T13:30:00");
    expect(resolveAge("90m", NOW)).toBe("2026-09-21T14:00:00");
    expect(resolveAge("1w", NOW)).toBe("2026-09-14T15:30:00");
    expect(resolveAge("6mo", NOW)).toBe("2026-03-25T15:30:00");
    expect(resolveAge("1y", NOW)).toBe("2025-09-21T15:30:00");
    expect(resolveAge("Today", NOW).slice(0, 10)).toBe("2026-09-21");
    expect(resolveAge("yesterday", NOW)).toBe("2026-09-20T12:00:00");
  });

  it("leave absolute dates and anything else alone", function () {
    for (const text of ["Mar 3, 2024", "2024-03-03", "3 days", "", "d", "3dd", undefined]) expect(resolveAge(text, NOW)).toBeNull();
  });

  it("are formatted per OS in the window, and fresh with the build's now", function () {
    const html = pane.folder("Apple.md | 2 KB | yesterday\nPear.md | 1 KB | 3d\nFig.md | 1 KB | Mar 3, 2024", { now: NOW }).html;
    const $ = cheerio.load(html);
    const dates = (os) => $(`.pane-d [data-os=${os}]`).toArray().map((e) => $(e).text());
    expect(dates("mac")).toEqual(["Yesterday", "9/18/26", "Mar 3, 2024"]);
    expect(dates("win")).toEqual(["9/20/2026 12:00 PM", "9/18/2026 3:30 PM", "Mar 3, 2024"]);
    expect(dates("linux")).toEqual(["Yesterday 12:00", "18 Sep 2026", "Mar 3, 2024"]);
    const later = cheerio.load(pane.folder("Pear.md | 1 KB | 3d", { now: "2026-10-05T09:00:00" }).html);
    expect(later(".pane-d [data-os=mac]").text()).toBe("10/2/26");
  });
});

describe("pane date formats close to now", function () {
  it("says Today and Yesterday like each OS, and plain dates after that (checked against captures)", function () {
    const at = (day, time) => `2026-09-${day}T${time}:00`;
    expect(formatDate(at(21, "09:05"), "mac", NOW)).toBe("9:05 AM");
    expect(formatDate(at(20, "23:59"), "mac", NOW)).toBe("Yesterday");
    expect(formatDate(at(19, "10:00"), "mac", NOW)).toBe("9/19/26");
    expect(formatDate(at(21, "09:05"), "linux", NOW)).toBe("Today 9:05");
    expect(formatDate(at(20, "23:59"), "linux", NOW)).toBe("Yesterday 23:59");
    expect(formatDate(at(19, "10:00"), "linux", NOW)).toBe("19 Sep 2026"); // no weekday names
    expect(formatDate(at(15, "10:00"), "linux", NOW)).toBe("15 Sep 2026");
    expect(formatDate(at(20, "23:59"), "win", NOW)).toBe("9/20/2026 11:59 PM");
  });

  it("counts calendar days, not 24-hour spans", function () {
    expect(formatDate("2026-09-20T23:59:00", "mac", "2026-09-21T00:01:00")).toBe("Yesterday");
    expect(formatDate("2026-09-21T00:00:00", "mac", "2026-09-21T23:59:00")).toBe("12:00 AM");
  });
});

describe("pane transform and now", function () {
  const doc = '<pre class="folder" title="Site"><code>Pages\n  About.txt\nPosts</code></pre>';
  const render = (now) => {
    const $ = cheerio.load(doc, { decodeEntities: false }, false);
    pane.transform($, { now });
    return $.html();
  };

  it("passes the build time to every window, so pages of one build agree", function () {
    expect(render(NOW)).toBe(render(NOW));
    expect(render(NOW)).not.toBe(render("2026-10-30T10:00:00"));
  });

  it("is a constant without a now, never the clock", function () {
    expect(render(undefined)).toBe(render(undefined));
  });
});

describe("pane GNOME window with a Yesterday date", function () {
  const yd = (html) => /^<figure class="pane pane-yd"/.test(html);

  it("gets the wider Modified column (class pane-yd) only when a row says Yesterday", function () {
    expect(yd(pane.folder("a.md | 1 KB | yesterday", { now: NOW }).html)).toBe(true);
    expect(yd(pane.folder("a.md | 1 KB | 3d", { now: NOW }).html)).toBe(false);
    expect(yd(pane.folder("a.md | 1 KB | 2h", { now: NOW }).html)).toBe(false);
  });

  it("applies to windows that GNOME can show, not to ones pinned to another OS", function () {
    expect(yd(pane.folder("a.md | 1 KB | yesterday", { now: NOW, os: "linux" }).html)).toBe(true);
    expect(yd(pane.folder("a.md | 1 KB | yesterday", { now: NOW, os: "mac" }).html)).toBe(false);
    expect(yd(pane.folder("a.md | 1 KB | yesterday", { now: NOW, os: "win" }).html)).toBe(false);
  });

  it("is what an invented-date window usually is, so the docs' windows get it", function () {
    expect(yd(pane.folder("a.md\nb.md\nc.md", { now: NOW }).html)).toBe(true); // rank 1 is yesterday
  });
});

