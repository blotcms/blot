describe("replaceFolderLinks stats", function () {
  const {
    createStats,
    record,
    classifyForm,
    classifySource,
    summarize,
    formatLine,
  } = require("../stats");

  describe("classifyForm", function () {
    it("classifies root, relative, host and static links", function () {
      expect(classifyForm("/a/b.jpg", "/a/b.jpg")).toEqual("root");
      expect(classifyForm("a/b.jpg", "a/b.jpg")).toEqual("relative");
      expect(classifyForm("b.jpg?x=1", "b.jpg?x=1")).toEqual("relative");
      expect(
        classifyForm("https://foo.blot.im/a/b.jpg", "/a/b.jpg")
      ).toEqual("host");
      expect(classifyForm("//foo.blot.im/a/b.jpg", "/a/b.jpg")).toEqual("host");
      expect(classifyForm("/fonts/a.woff2", "/fonts/a.woff2")).toEqual("static");
      expect(classifyForm("/icons/a.svg?v=1#x", "/icons/a.svg?v=1#x")).toEqual(
        "static"
      );
      expect(
        classifyForm("https://foo.blot.im/fonts/a.woff2", "/fonts/a.woff2")
      ).toEqual("static");
    });

    it("does not treat lookalike paths as static", function () {
      expect(classifyForm("/fontsFoo/a.jpg", "/fontsFoo/a.jpg")).toEqual("root");
    });
  });

  describe("classifySource", function () {
    const original = "/images/a.jpg";

    it("prefers the template view source", function () {
      expect(
        classifySource(original, {
          view: `<img src="${original}">`,
          partials: {},
          locals: { entry: { html: `<img src="${original}">` } },
        })
      ).toEqual("template");
    });

    it("finds links in template partials", function () {
      expect(
        classifySource(original, {
          view: "{{> header}}",
          partials: { header: `<link href="${original}">` },
          locals: {},
        })
      ).toEqual("template");
    });

    it("finds links in entry html", function () {
      expect(
        classifySource(original, {
          view: "{{{entry.html}}}",
          partials: {},
          locals: { entry: { html: `<p><img src="${original}"></p>` } },
        })
      ).toEqual("entry");
    });

    it("finds links in the html of listed entries", function () {
      for (const name of ["entries", "posts"]) {
        expect(
          classifySource(original, {
            view: "{{#entries}}{{{html}}}{{/entries}}",
            partials: {},
            locals: { [name]: [{ html: "<p>no</p>" }, { html: original }] },
          })
        ).toEqual("entry");
      }

      expect(
        classifySource(original, {
          view: "",
          partials: {},
          locals: { tagged: { entries: [{ html: original }] } },
        })
      ).toEqual("entry");
    });

    it("finds links in entries under any local, including nested archives", function () {
      for (const locals of [
        { recent_entries: [{ html: original }] },
        { latest_entry: { html: original } },
        { archives: [{ months: [{ entries: [{ html: original }] }] }] },
      ]) {
        expect(
          classifySource(original, { view: "", partials: {}, locals })
        ).toEqual("entry");
      }
    });

    it("finds links in entry markup fields other than html", function () {
      for (const field of ["body", "teaser", "teaserBody"]) {
        expect(
          classifySource(original, {
            view: "",
            partials: {},
            locals: { posts: [{ [field]: `<img src="${original}">` }] },
          })
        ).toEqual("entry");
      }
    });

    it("finds links in entry metadata", function () {
      expect(
        classifySource(original, {
          view: "{{entry.metadata.cover}}",
          partials: {},
          locals: {
            entry: { html: "<p>no</p>", metadata: { cover: original, n: 1 } },
          },
        })
      ).toEqual("metadata");
    });

    it("falls back to other", function () {
      expect(
        classifySource(original, {
          view: "{{menu}}",
          partials: { p: "x" },
          locals: { entry: { html: "x" }, entries: "nope", posts: null },
        })
      ).toEqual("other");
    });

    it("matches values that were entity-encoded in the source", function () {
      expect(
        classifySource("/a.jpg?x=1&y=2", {
          view: '<img src="/a.jpg?x=1&amp;y=2">',
          partials: {},
          locals: {},
        })
      ).toEqual("template");
    });

    it("tolerates missing partials and locals", function () {
      expect(classifySource(original, {})).toEqual("other");
    });
  });

  describe("summarize", function () {
    it("counts rewrites and missing files by source and form", function () {
      const stats = createStats("html");
      stats.parsed = true;
      record(stats, "/t.jpg", "/t.jpg", false);
      record(stats, "e.jpg", "e.jpg", false);
      record(stats, "https://foo.blot.im/e2.jpg", "/e2.jpg", false);
      record(stats, "/missing.jpg", "/missing.jpg", true);

      const summary = summarize(stats, {
        blogID: "blog_1",
        ms: 2.4,
        view: '<img src="/t.jpg">',
        partials: {},
        locals: {
          entry: { html: '<img src="e.jpg"><img src="https://foo.blot.im/e2.jpg">' },
        },
      });

      expect(summary.blogID).toEqual("blog_1");
      expect(summary.kind).toEqual("html");
      expect(summary.parsed).toBe(true);
      expect(summary.rewrites).toEqual(3);
      expect(summary.enoent).toEqual(1);
      expect(summary.sources).toEqual({ template: 1, entry: 2 });
      expect(summary.forms).toEqual({ root: 1, relative: 1, host: 1 });
      expect(summary.sample).toEqual([
        { status: "ok", source: "template", form: "root", original: "/t.jpg" },
        { status: "ok", source: "entry", form: "relative", original: "e.jpg" },
        {
          status: "ok",
          source: "entry",
          form: "host",
          original: "https://foo.blot.im/e2.jpg",
        },
      ]);
    });
  });

  describe("formatLine", function () {
    it("formats one greppable line with encoded, truncated samples", function () {
      const stats = createStats("css");
      stats.parsed = true;
      record(stats, "/a b,c.jpg", "/a b,c.jpg", false);
      record(stats, "/" + "x".repeat(200), "/" + "x".repeat(200), true);

      const line = formatLine(
        summarize(stats, {
          blogID: "blog_1",
          ms: 3.6,
          view: "/a b,c.jpg",
          partials: {},
          locals: {},
        }),
        { handle: "foo", templateID: "SITE:blog", view: "style.css" }
      );

      expect(line).toMatch(
        /^\[folder-links\] blog=blog_1 handle=foo template=SITE:blog view=style\.css kind=css rewrites=1 enoent=1 ms=4 sources=template:1 forms=root:1 sample=ok:template:root:\/a%20b%2Cc\.jpg,enoent:other:root:\/x{119}$/
      );
      expect(line.split(" ").length).toEqual(12);
    });
  });
});
