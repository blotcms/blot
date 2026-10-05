describe("backlinks", function () {
  const Entry = require("models/entry");
  const { createBacklinks, isNeeded } = require("../load/backlinks");

  function entryWith(path, backlinks) {
    return { path, backlinks };
  }

  function stubLookups(entriesByUrl, error) {
    return spyOn(Entry, "getByUrl").and.callFake((blogID, url, callback) =>
      callback(entriesByUrl[url], error)
    );
  }

  it("reads each linked URL once and shares the result between entries", async function () {
    const target = { path: "/target.txt", html: "<p>big</p>" };
    const getByUrl = stubLookups({ "/target": target });
    const backlinks = createBacklinks("blog");

    const [a, b] = await Promise.all([
      backlinks.resolve(entryWith("/a.txt", ["/target"])),
      backlinks.resolve(entryWith("/b.txt", ["/target"])),
    ]);

    expect(getByUrl.calls.count()).toBe(1);
    expect(a[0]).toBe(target);
    expect(b[0]).toBe(target);
  });

  it("trims each looked-up entry once, before sharing it", async function () {
    const target = { path: "/target.txt", html: "<p>big</p>" };
    stubLookups({ "/target": target });
    const project = jasmine.createSpy("project").and.callFake((entry) => {
      delete entry.html;
    });
    const backlinks = createBacklinks("blog", { project });

    await backlinks.resolve(entryWith("/a.txt", ["/target"]));
    const [resolved] = await backlinks.resolve(entryWith("/b.txt", ["/target"]));

    expect(project.calls.count()).toBe(1);
    expect(resolved.html).toBeUndefined();
  });

  it("leaves out missing, unpublished, own and repeated entries", async function () {
    stubLookups({
      "/scheduled": { path: "/scheduled.txt", scheduled: true },
      "/self": { path: "/me.txt" },
      "/one": { path: "/one.txt" },
      "/one-again": { path: "/one.txt" },
    });

    const resolved = await createBacklinks("blog").resolve(
      entryWith("/me.txt", ["/missing", "/scheduled", "/self", "/one", "/one-again", 7])
    );

    expect(resolved.map((entry) => entry.path)).toEqual(["/one.txt"]);
  });

  it("reports a failed lookup, and still resolves the rest", async function () {
    const backlinks = createBacklinks("blog");
    expect(backlinks.failed).toBe(false);

    stubLookups({}, new Error("redis down"));
    expect(await backlinks.resolve(entryWith("/a.txt", ["/x"]))).toEqual([]);
    expect(backlinks.failed).toBe(true);
  });

  it("does not report a URL with no entry as a failure", async function () {
    const backlinks = createBacklinks("blog");
    stubLookups({});

    await backlinks.resolve(entryWith("/a.txt", ["/x"]));

    expect(backlinks.failed).toBe(false);
  });

  it("looks nothing up when disabled", async function () {
    const getByUrl = stubLookups({ "/target": { path: "/target.txt" } });
    const backlinks = createBacklinks("blog", { enabled: false });

    expect(await backlinks.resolve(entryWith("/a.txt", ["/target"]))).toEqual([]);
    expect(getByUrl).not.toHaveBeenCalled();
  });

  it("is needed unless the request says its view never uses backlinks", function () {
    expect(isNeeded({})).toBe(true);
    expect(isNeeded({ usesBacklinks: true })).toBe(true);
    expect(isNeeded({ usesBacklinks: false })).toBe(false);
  });
});
