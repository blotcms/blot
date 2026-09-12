const recentEntries = require("../recent_entries");
const Entries = require("models/entries");

describe("recent_entries", function () {
  function run(req) {
    return new Promise((resolve, reject) => {
      recentEntries(req, {}, (err, result) =>
        err ? reject(err) : resolve(result)
      );
    });
  }

  it("fetches the full entry list when no field projection metadata is present", async function () {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, callback) {
      callback([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const result = await run({ blog: { id: "blog-1" }, retrieve: {} });

    expect(Entries.getRecent).toHaveBeenCalledWith(
      "blog-1",
      jasmine.any(Function)
    );
    expect(result).toEqual([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
  });

  it("strips unreferenced heavy fields when the template only references non-heavy fields", async function () {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, callback) {
      callback([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const result = await run({
      blog: { id: "blog-1" },
      retrieve: { recentEntries: { fields: { title: true } } },
    });

    // The template only referenced `title`, so the unreferenced heavy `html`
    // field should be stripped even though the fetch above returned it.
    expect(result).toEqual([{ id: "/a.txt", title: "A" }]);
  });

  it("recognizes the recent_entries alias", async function () {
    spyOn(Entries, "getRecent").and.callFake(function (blogID, callback) {
      callback([{ id: "/a.txt", title: "A", html: "<p>A</p>" }]);
    });

    const result = await run({
      blog: { id: "blog-1" },
      retrieve: { recent_entries: { fields: { title: true } } },
    });

    expect(result).toEqual([{ id: "/a.txt", title: "A" }]);
  });
});
