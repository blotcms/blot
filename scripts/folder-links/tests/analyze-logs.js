describe("folder-links analyze-logs", function () {
  const { parseLine, aggregate, format } = require("../analyze-logs");

  const rewriteLine = (fields) =>
    "[05/Oct/2026:12:00:00 +0000] abc-123 +4ms [folder-links] " + fields;

  const a = rewriteLine(
    "blog=blog_1 handle=foo template=SITE:blog view=entries.html kind=html rewrites=3 enoent=1 ms=4 sources=template:2,entry:1 forms=root:2,relative:1 sample=ok:template:root:/a.jpg,ok:entry:relative:b.jpg,enoent:entry:root:/gone.jpg"
  );
  const b = rewriteLine(
    "blog=blog_2 handle=bar template=SITE:other view=style.css kind=css rewrites=1 enoent=0 ms=2 sources=template:1 forms=host:1 sample=ok:template:host:https://bar.blot.im/a.jpg?x=1%2C2"
  );
  const origin =
    "[05/Oct/2026:12:00:01 +0000] def-456 +1ms [folder-asset-origin] blog=blog_1 handle=foo path=/photos/a%20b.jpg referer_path=/post";

  it("ignores unrelated lines", function () {
    expect(parseLine("[05/Oct/2026:12:00:00 +0000] abc 200 0.013 https://x/")).toBeNull();
    expect(parseLine("[folder-links] garbage")).toBeNull();
  });

  it("parses a [folder-links] line", function () {
    expect(parseLine(a)).toEqual({
      type: "rewrite",
      blog: "blog_1",
      handle: "foo",
      template: "SITE:blog",
      view: "entries.html",
      kind: "html",
      rewrites: 3,
      enoent: 1,
      ms: 4,
      sources: { template: 2, entry: 1 },
      forms: { root: 2, relative: 1 },
      samples: [
        { status: "ok", source: "template", form: "root", value: "/a.jpg" },
        { status: "ok", source: "entry", form: "relative", value: "b.jpg" },
        { status: "enoent", source: "entry", form: "root", value: "/gone.jpg" },
      ],
    });
  });

  it("keeps colons in sample values and decodes them", function () {
    expect(parseLine(b).samples).toEqual([
      {
        status: "ok",
        source: "template",
        form: "host",
        value: "https://bar.blot.im/a.jpg?x=1,2",
      },
    ]);
  });

  it("parses a [folder-asset-origin] line", function () {
    expect(parseLine(origin)).toEqual({
      type: "origin",
      blog: "blog_1",
      handle: "foo",
      path: "/photos/a b.jpg",
      refererPath: "/post",
    });
  });

  it("aggregates both line types", function () {
    const report = aggregate([a, b, origin, origin].map(parseLine), 5);

    expect(report.totals).toEqual({ passes: 2, rewrites: 4, enoent: 1, ms: 6 });
    expect(report.kinds).toEqual({ html: 3, css: 1 });
    expect(report.sources).toEqual({ template: 3, entry: 1 });
    expect(report.forms).toEqual({ root: 2, relative: 1, host: 1 });
    expect(report.topBlogs).toEqual([
      { blog: "blog_1", handle: "foo", n: 3 },
      { blog: "blog_2", handle: "bar", n: 1 },
    ]);
    expect(report.topViews[0]).toEqual({ view: "SITE:blog entries.html", n: 3 });
    expect(report.topSamples.template.map((s) => s.value).sort()).toEqual([
      "/a.jpg",
      "https://bar.blot.im/a.jpg?x=1,2",
    ]);
    expect(report.assetOrigin).toEqual({
      total: 2,
      topBlogs: [{ blog: "blog_1", handle: "foo", n: 2 }],
      topPaths: [{ path: "foo/photos/a b.jpg", n: 2 }],
    });
  });

  it("formats a text report", function () {
    const text = format(aggregate([a, origin].map(parseLine)));

    expect(text).toContain("passes logged: 1");
    expect(text).toContain("foo (blog_1)");
    expect(text).toContain("[folder-asset-origin]");
  });
});
