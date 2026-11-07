describe("template", function () {
  require("./setup")({ createTemplate: true });

  var getFullView = require("../index").getFullView;
  var setView = require("../index").setView;

  // Saves the views in parallel, as the callback each() loop used to
  const setViews = (templateID, views) =>
    Promise.all(views.map((view) => setView(templateID, view)));

  it("gets a full view", async function () {
    var test = this;

    var header = {
      name: "header.html",
      content: "<header>Header content</header>",
    };

    var view = {
      name: "page.html",
      locals: { words: "test words" },
      content: "Page content {{> " + header.name + "}}",
    };

    var views = [view, header];

    await setViews(test.template.id, views);

    const fullView = await getFullView(
      test.blog.id,
      test.template.id,
      view.name
    );

    expect(fullView).toEqual(jasmine.any(Array));

    var allPartials = {};
    allPartials[header.name] = header.content;

    expect(fullView[0]).toEqual(view.locals); // view.locals
    expect(fullView[1]).toEqual(allPartials); // allPartials
    expect(fullView[2]).toEqual({}); // view.retrieve
    expect(fullView[3]).toEqual("text/html"); // view.type
    expect(fullView[4]).toEqual(view.content);
  });

  [
    [
      "a partial",
      "{{> links.html}}",
      "{{#backlinks}}{{title}}{{/backlinks}}",
      true,
    ],
    [
      "the view",
      "{{#entry.backlinks}}{{title}}{{/entry.backlinks}}",
      "x",
      true,
    ],
    ["neither", "{{title}}{{> links.html}}", "{{url}}", false],
  ].forEach(function (example) {
    it("says whether backlinks are used: " + example[0], async function () {
      var test = this;

      await setViews(test.template.id, [
        { name: "entry.html", content: example[1] },
        { name: "links.html", content: example[2] },
      ]);

      const fullView = await getFullView(
        test.blog.id,
        test.template.id,
        "entry.html"
      );

      expect(fullView[5]).toBe(example[3]);
    });
  });

  it("merges projected allEntries fields from view and partials", async function () {
    var test = this;

    var partial = {
      name: "entry-url.html",
      content: "{{#allEntries}}{{url}}{{/allEntries}}",
    };

    var view = {
      name: "entries.html",
      content:
        "{{#allEntries}}{{title}}{{/allEntries}}{{> " + partial.name + "}}",
    };

    await setViews(test.template.id, [view, partial]);

    const fullView = await getFullView(
      test.blog.id,
      test.template.id,
      view.name
    );

    expect(fullView[2]).toEqual({
      allEntries: { fields: { title: true, url: true } },
    });
  });

  it("handles partial usage inside allEntries sections", async function () {
    var test = this;

    var partial = {
      name: "entry-partial.html",
      content: "{{{html}}}",
    };

    var view = {
      name: "entries-with-partial.html",
      content: "{{#allEntries}}{{> " + partial.name + "}}{{/allEntries}}",
    };

    await setViews(test.template.id, [view, partial]);

    const fullView = await getFullView(
      test.blog.id,
      test.template.id,
      view.name
    );

    expect(fullView[2]).toEqual({
      allEntries: { fields: { html: true } },
    });
  });

  it("keeps a heavy field a partial renders under a nested entry predicate", async function () {
    var test = this;

    var partial = {
      name: "entry-thumbnail-partial.html",
      content: "{{{html}}}",
    };

    var view = {
      name: "entries-thumbnail-with-partial.html",
      content:
        "{{#allEntries}}{{#thumbnail}}{{> " +
        partial.name +
        "}}{{/thumbnail}}{{/allEntries}}",
    };

    await setViews(test.template.id, [view, partial]);

    const fullView = await getFullView(
      test.blog.id,
      test.template.id,
      view.name
    );

    // {{{html}}} inside {{#thumbnail}} has no `thumbnail.html`, so Mustache
    // resolves it from the parent entry - projection must keep `html`.
    // `thumbnail` is still recorded, and nothing leaks to the top level.
    expect(fullView[2]).toEqual({
      allEntries: { fields: { thumbnail: true, html: true } },
    });
  });

  it("projects fields from partials used inside tagged.entries", async function () {
    var test = this;

    var partial = {
      name: "tagged-entry-partial.html",
      content: "{{title}}",
    };

    var view = {
      name: "tagged-with-partial.html",
      content:
        "{{#tagged.entries}}{{> " + partial.name + "}}{{/tagged.entries}}",
    };

    await setViews(test.template.id, [view, partial]);

    const fullView = await getFullView(
      test.blog.id,
      test.template.id,
      view.name
    );

    expect(fullView[2]).toEqual({
      tagged: { fields: { title: true } },
    });
  });

  it("keeps a heavy field a nested partial renders in a fresh context", async function () {
    var test = this;

    // `item` is first used at the root, then reached again through `wrapper`
    // inside {{#allEntries}}. The bundle backstop must still keep `html`.
    var item = { name: "bundle-item.html", content: "{{{html}}}" };
    var wrapper = {
      name: "bundle-wrapper.html",
      content: "{{> " + item.name + "}}",
    };
    var view = {
      name: "bundle-parent.html",
      content:
        "{{> " +
        item.name +
        "}}{{#allEntries}}{{title}}{{> " +
        wrapper.name +
        "}}{{/allEntries}}",
    };

    await setViews(test.template.id, [item, wrapper, view]);

    const fullView = await getFullView(
      test.blog.id,
      test.template.id,
      view.name
    );

    expect(fullView[2].allEntries.fields.html).toBe(true);
    expect(fullView[2].allEntries.fields.title).toBe(true);
  });

  it("does not keep a heavy field referenced only from a string local", async function () {
    var test = this;

    var view = {
      name: "snippet-view.html",
      locals: { snippet: "{{#allEntries}}{{{html}}}{{/allEntries}}" },
      content: "{{#allEntries}}{{title}}{{/allEntries}}{{{snippet}}}",
    };

    await setView(test.template.id, view);

    const fullView = await getFullView(
      test.blog.id,
      test.template.id,
      view.name
    );

    expect(fullView[2].allEntries.fields.html).toBeUndefined();
    expect(fullView[2].allEntries.fields.title).toBe(true);
  });
});
