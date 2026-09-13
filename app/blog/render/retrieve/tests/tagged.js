describe("tagged block", function () {
  require("blog/tests/util/setup")();

  it("lists entries for a single tag", async function () {
    await this.write({
      path: "/first.txt",
      content: "Title: First\nTags: foo\n\nFirst body",
    });
    await this.write({
      path: "/second.txt",
      content: "Title: Second\nTags: foo\n\nSecond body",
    });
    await this.write({
      path: "/other.txt",
      content: "Title: Other\nTags: bar\n\nOther body",
    });

    await this.template({
      "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
    });

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>Second</li><li>First</li></ul>");
  });

  it("fetches tagged entries once when a view binds both {{#entries}} and {{#tagged}}", async function () {
    await this.write({
      path: "/first.txt",
      content: "Title: First\nTags: foo\n\nFirst body",
    });
    await this.write({
      path: "/second.txt",
      content: "Title: Second\nTags: foo\n\nSecond body",
    });

    // routes/tagged.js always fetches the {{#entries}} page; a view that
    // also references {{#tagged}} must not trigger a second
    // fetchTaggedEntries/Entry.get pass. See
    // https://github.com/davidmerfield/blot/issues/1844
    await this.template({
      "tagged.html":
        "{{#entries}}{{title}}-e {{/entries}}{{#tagged}}{{#entries}}{{title}}-t {{/entries}}{{/tagged}}",
    });

    // Publishing/indexing the entries above also calls Entry.get - only spy
    // once that's done, so the count below reflects just the request.
    const Entry = require("models/entry");
    spyOn(Entry, "get").and.callThrough();

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body).toContain("Second-e");
    expect(body).toContain("Second-t");
    expect(Entry.get).toHaveBeenCalledTimes(1);
  });

  it('does not leak entries across an "undefined" string path_prefix set on the tagged.html view', async function () {
    await this.write({
      path: "/undefined/inside.txt",
      content: "Title: Inside\nTags: foo\n\nInside body",
    });
    await this.write({
      path: "/elsewhere/outside.txt",
      content: "Title: Outside\nTags: foo\n\nOutside body",
    });

    // A per-VIEW path_prefix (as opposed to a template-level one) isn't
    // visible to routes/tagged.js's own fetch, which runs before
    // render/middleware.js merges the view's locals in. That fetch's
    // (unfiltered) result must not collide, via key serialization, with
    // the later fetch that resolves the view's literal string
    // path_prefix: "undefined" - String(undefined) === "undefined" would
    // make the two indistinguishable. See
    // https://github.com/davidmerfield/blot/issues/1844
    await this.template(
      {
        "tagged.html":
          "{{#entries}}{{title}}-e {{/entries}}{{#tagged}}{{#entries}}{{title}}-t {{/entries}}{{/tagged}}",
      },
      { views: { "tagged.html": { locals: { path_prefix: "undefined" } } } }
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    // The route's own fetch runs before the view's path_prefix is
    // resolved, so the top-level {{#entries}} local stays unfiltered.
    expect(body).toContain("Inside-e");
    expect(body).toContain("Outside-e");
    // {{#tagged}}{{#entries}} must only include the "/undefined/" folder.
    expect(body).toContain("Inside-t");
    expect(body).not.toContain("Outside-t");
  });

  it("keeps existing tagged behavior when path_prefix is not set", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/notes/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });

    await this.template({
      "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
    });

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>Two</li><li>One</li></ul>");
  });

  it("exposes metadata and helpers for the current tag", async function () {
    await this.write({ path: "/a.txt", content: "Tags: Featured\n\nAlpha" });

    await this.template({
      "tagged.html": `{{#tagged}}{{tag}}|{{#tagged.Featured}}upper{{/tagged.Featured}}|{{#tagged.featured}}lower{{/tagged.featured}}|{{#is.featured}}alias{{/is.featured}}{{/tagged}}`,
    });

    const res = await this.get("/tagged/Featured");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("Featured|upper|lower|alias");
  });

  it("filters entries by the intersection of multiple tags", async function () {
    await this.write({
      path: "/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/two.txt",
      content: "Title: Two\nTags: foo, bar\n\nTwo body",
    });
    await this.write({
      path: "/three.txt",
      content: "Title: Three\nTags: bar\n\nThree body",
    });
    await this.write({
      path: "/four.txt",
      content: "Title: Four\nTags: foo, bar\n\nFour body",
    });

    await this.template({
      "entries.html": `<p>{{#tagged}}{{tag}}:{{#entries}}{{title}}|{{/entries}}{{/tagged}}</p>`,
    });

    const res = await this.get("/?tag=foo&tag=bar");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<p>foo + bar:Four|Two|</p>");
  });

  it("filters tagged entries by path_prefix", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/notes/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });
    await this.write({
      path: "/blog/three.txt",
      content: "Title: Three\nTags: foo\n\nThree body",
    });

    await this.template(
      {
        "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
      },
      {
        locals: {
          path_prefix: "/blog/",
        },
      },
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>Three</li><li>One</li></ul>");
  });

  it("excludes pages from tagged listings and pagination totals", async function () {
    await this.write({
      path: "/work/post.txt",
      content: "Title: Car post\nTags: automotive\n\nPost body",
    });
    await this.write({
      path: "/work/page.txt",
      content: "Title: Car page\nTags: automotive\nPage: yes\n\nPage body",
    });

    await this.template(
      {
        "tagged.html": `{{#tagged}}{{total}}|{{pagination.total}}|{{#entries}}{{title}}{{/entries}}{{/tagged}}`,
      },
      {
        views: {
          "tagged.html": {
            url: ["/work/tagged/:tag", "/work/tagged/:tag/page/:page"],
          },
        },
        locals: {
          path_prefix: "/work/",
          tagged_page_size: 1,
        },
      },
    );

    const res = await this.get("/work/tagged/automotive");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("1|1|Car post");
  });

  it("treats empty and whitespace path_prefix as disabled filtering", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/notes/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });

    await this.template(
      {
        "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
      },
      {
        locals: {
          path_prefix: "   ",
        },
      },
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>Two</li><li>One</li></ul>");
  });

  it("normalizes path_prefix values that are missing a leading slash", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/notes/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });

    await this.template(
      {
        "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
      },
      {
        locals: {
          path_prefix: "blog/",
        },
      },
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>One</li></ul>");
  });

  it("respects trailing slash path_prefix boundaries", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/blog-two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });

    await this.template(
      {
        "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
      },
      {
        locals: {
          path_prefix: "/blog/",
        },
      },
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>One</li></ul>");
  });

  it("ignores non-string entry IDs when filtering by path_prefix", function (done) {
    const tagged = require("blog/render/retrieve/tagged");
    const Tags = require("models/tags");
    const Entry = require("models/entry");

    spyOn(Tags, "get").and.callFake(function (blogID, slug, callback) {
      callback(null, ["/blog/one.txt", 7, null, "/notes/two.txt"], "foo", 4);
    });

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      expect(entryIDs).toEqual(["/blog/one.txt"]);
      callback([{ id: "/blog/one.txt", title: "One", dateStamp: 1 }]);
    });

    const req = {
      blog: { id: this.blog.id },
      query: { tag: "foo" },
      params: {},
      template: { locals: {} },
    };

    const res = {
      locals: { path_prefix: "/blog/" },
    };

    tagged(req, res, function (err, result) {
      expect(err).toBeNull();
      expect(result.entryIDs).toEqual(["/blog/one.txt"]);
      expect(result.total).toBe(1);
      done();
    });
  });

  it("paginates tagged entries using filtered totals when path_prefix is set", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/blog/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });
    await this.write({
      path: "/notes/three.txt",
      content: "Title: Three\nTags: foo\n\nThree body",
    });

    await this.template(
      {
        "tagged.html": `{{#tagged}}{{total}}|{{pagination.total}}|{{pagination.current}}|{{#entries}}{{title}}{{/entries}}{{/tagged}}`,
      },
      {
        locals: {
          path_prefix: "/blog/",
          tagged_page_size: 1,
        },
      },
    );

    const res = await this.get("/tagged/foo/page/2");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("2|2|2|One");
  });

  it("paginates multi-tag intersections without path_prefix filtering", async function () {
    await this.write({
      path: "/one.txt",
      content: "Title: One\nTags: foo, bar\n\nOne body",
    });
    await this.write({
      path: "/two.txt",
      content: "Title: Two\nTags: foo, bar\n\nTwo body",
    });
    await this.write({
      path: "/three.txt",
      content: "Title: Three\nTags: foo\n\nThree body",
    });

    await this.template(
      {
        "tagged.html": `{{#tagged}}{{total}}|{{pagination.total}}|{{pagination.current}}|{{#entries}}{{title}}{{/entries}}{{/tagged}}`,
      },
      {
        locals: {
          tagged_page_size: 1,
        },
      },
    );

    const res = await this.get("/tagged/foo/page/2?tag=foo&tag=bar");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("2|2|2|One");
  });

  it("paginates multi-tag intersections using filtered totals when path_prefix is set", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo, bar\n\nOne body",
    });
    await this.write({
      path: "/blog/two.txt",
      content: "Title: Two\nTags: foo, bar\n\nTwo body",
    });
    await this.write({
      path: "/notes/three.txt",
      content: "Title: Three\nTags: foo, bar\n\nThree body",
    });

    await this.template(
      {
        "tagged.html": `{{#tagged}}{{total}}|{{pagination.total}}|{{pagination.current}}|{{#entries}}{{title}}{{/entries}}{{/tagged}}`,
      },
      {
        locals: {
          path_prefix: "/blog/",
          tagged_page_size: 1,
        },
      },
    );

    const res = await this.get("/tagged/foo/page/2?tag=foo&tag=bar");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("2|2|2|One");
  });
});
