describe("hardenProjectedRetrieve", function () {
  var harden = require("../util/hardenProjectedRetrieve");

  it("keeps a heavy field only referenced inside a partial", function () {
    var retrieve = { posts: { fields: { title: true } } };
    harden(
      retrieve,
      "{{> item}}{{#posts}}{{title}}{{> wrapper}}{{/posts}}",
      { item: "{{{html}}}", wrapper: "{{> item}}" }
    );
    expect(retrieve).toEqual({ posts: { fields: { title: true, html: true } } });
  });

  it("keeps a heavy field referenced through a numeric list index", function () {
    var retrieve = { posts: { fields: { title: true } } };
    harden(retrieve, "{{#posts}}{{title}}{{/posts}}{{{posts.0.html}}}", {});
    expect(retrieve.posts.fields).toEqual({ title: true, html: true });
  });

  it("extracts references from a partial that changes delimiters", function () {
    var retrieve = { posts: { fields: { title: true } } };
    harden(retrieve, "{{#posts}}{{title}}{{> d}}{{/posts}}", {
      d: "{{=<% %>=}}<%{html}%>",
    });
    expect(retrieve.posts.fields).toEqual({ title: true, html: true });
  });

  it("leaves a boolean (unknown) retrieve value untouched", function () {
    var retrieve = { posts: true };
    harden(retrieve, "{{#posts}}{{{html}}}{{/posts}}", {});
    expect(retrieve).toEqual({ posts: true });
  });

  it("does nothing when no heavy field is referenced anywhere", function () {
    var retrieve = { allEntries: { fields: { title: true, url: true } } };
    harden(retrieve, "{{#allEntries}}{{title}} {{url}}{{/allEntries}}", {
      p: "{{title}}",
    });
    expect(retrieve).toEqual({
      allEntries: { fields: { title: true, url: true } },
    });
  });

  it("is conservative when a fragment does not parse on its own", function () {
    var retrieve = { allEntries: { fields: { title: true } } };
    harden(retrieve, "{{#allEntries}}{{title}}{{/allEntries}}", {
      broken: "{{#x}} still open",
    });
    expect(Object.keys(retrieve.allEntries.fields).sort()).toEqual([
      "body",
      "html",
      "summary",
      "teaser",
      "teaserBody",
      "title",
    ]);
  });

  it("keeps a heavy field referenced only from a string local", function () {
    var retrieve = { posts: { fields: { title: true } } };
    harden(
      retrieve,
      "{{#posts}}{{title}}{{/posts}}{{{snippet}}}",
      {},
      { snippet: "{{#posts}}{{{html}}}{{/posts}}", nested: { deep: "{{{body}}}" } }
    );
    expect(retrieve.posts.fields).toEqual({
      title: true,
      html: true,
      body: true,
    });
  });

  it("scans arbitrarily deep local nesting", function () {
    var retrieve = { posts: { fields: { title: true } } };
    harden(retrieve, null, null, {
      a: { b: { c: { d: { e: { f: { g: "{{#posts}}{{{html}}}{{/posts}}" } } } } } },
    });
    expect(retrieve.posts.fields).toEqual({ title: true, html: true });
  });

  it("does not loop on a cyclic locals object", function () {
    var locals = { x: "{{{body}}}" };
    locals.self = locals;
    var retrieve = { posts: { fields: { title: true } } };
    harden(retrieve, null, null, locals);
    expect(retrieve.posts.fields).toEqual({ title: true, body: true });
  });

  it("scans nested objects of locals (e.g. inherited template/blog locals)", function () {
    var retrieve = { posts: { fields: { title: true } } };
    harden(retrieve, null, null, {
      template: { snippet: "{{#posts}}{{{html}}}{{/posts}}" },
      blog: { footer: "{{{body}}}" },
    });
    expect(retrieve.posts.fields).toEqual({
      title: true,
      html: true,
      body: true,
    });
  });

  it("keeps a heavy field found in entry-backed partial content", function () {
    var retrieve = { posts: { fields: { title: true } } };
    harden(retrieve, "{{#posts}}{{title}}{{> /snippet.txt}}{{/posts}}", {
      "/snippet.txt": "<div>{{{html}}}</div>",
    });
    expect(retrieve.posts.fields).toEqual({ title: true, html: true });
  });
});
