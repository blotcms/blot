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

  it("does not treat string locals as templates", function () {
    var retrieve = { posts: { fields: { title: true } } };
    harden(
      retrieve,
      "{{#posts}}{{title}}{{/posts}}{{{snippet}}}",
      {},
      { snippet: "{{#posts}}{{{html}}}{{/posts}}", nested: { deep: "{{{body}}}" } }
    );
    expect(retrieve.posts.fields).toEqual({ title: true });
  });

  it("keeps a heavy field found in entry-backed partial content", function () {
    var retrieve = { posts: { fields: { title: true } } };
    harden(retrieve, "{{#posts}}{{title}}{{> /snippet.txt}}{{/posts}}", {
      "/snippet.txt": "<div>{{{html}}}</div>",
    });
    expect(retrieve.posts.fields).toEqual({ title: true, html: true });
  });
});
