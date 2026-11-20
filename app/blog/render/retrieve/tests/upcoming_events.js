const Entries = require("models/entries");
const upcoming = require("../upcoming_events");

describe("upcoming_events", function () {
  const blog = { id: "blog-events", cacheID: 1, timeZone: "UTC" };
  const entry = (title, event, extra = {}) => ({
    id: title,
    title,
    url: "/" + title,
    metadata: event ? { event } : {},
    tags: [],
    ...extra,
  });

  beforeEach(function () {
    upcoming._clear();
    spyOn(Entries, "getCatalog").and.callFake(async () => [
      entry("later", "2027-01-12 19:00"),
      entry("sooner", "2026-12-08 18:30"),
      entry("past", "2025-06-17 19:00"),
      entry("prose", "Tuesday, December 8"),
      entry("none", null),
      entry("draft", "2026-12-09 18:00", { draft: true }),
    ]);
  });

  const now = Date.parse("2026-11-20T12:00:00Z");

  it("lists events still to come, soonest first", async function () {
    const result = await upcoming._upcomingEvents(
      { blog, template: { locals: {} } },
      {},
      now
    );
    expect(result.map((e) => e.title)).toEqual(["sooner", "later"]);
  });

  it("stops at the template's limit", async function () {
    const result = await upcoming._upcomingEvents(
      { blog, template: { locals: { upcoming_events_limit: 1 } } },
      {},
      now
    );
    expect(result.map((e) => e.title)).toEqual(["sooner"]);
  });

  it("reads the catalog once per cacheID", async function () {
    const req = { blog, template: { locals: {} } };
    await upcoming._upcomingEvents(req, {}, now);
    await upcoming._upcomingEvents(req, {}, now);
    expect(Entries.getCatalog).toHaveBeenCalledTimes(1);
  });

  it("hands out copies the render can change", async function () {
    const req = { blog, template: { locals: {} } };
    const first = await upcoming._upcomingEvents(req, {}, now);
    first[0].title = "changed";
    const second = await upcoming._upcomingEvents(req, {}, now);
    expect(second[0].title).toEqual("sooner");
  });
});
