describe("projectEntryFields", function () {
  var projectEntryFields = require("blog/render/retrieve/helpers/projectEntryFields");

  function entry(overrides) {
    return Object.assign(
      {
        id: "1",
        url: "/one",
        title: "One",
        tags: [],
        dateStamp: 1,
        html: "<p>one</p>",
        body: "one",
        teaser: "one teaser",
        teaserBody: "one teaser body",
        summary: "one summary",
      },
      overrides || {}
    );
  }

  it("strips every heavy field when the view references only light fields", function () {
    var entries = [entry(), entry({ id: "2", url: "/two" })];

    projectEntryFields(entries, { all_entries: { fields: { title: true, url: true } } }, ["all_entries"]);

    entries.forEach(function (e) {
      expect(e.title).toBeDefined();
      expect(e.url).toBeDefined();
      expect(e.html).toBeUndefined();
      expect(e.body).toBeUndefined();
      expect(e.teaser).toBeUndefined();
      expect(e.teaserBody).toBeUndefined();
      expect(e.summary).toBeUndefined();
    });
  });

  it("keeps heavy fields the view references", function () {
    var entries = [entry()];

    projectEntryFields(
      entries,
      { all_entries: { fields: { html: true, title: true } } },
      ["all_entries"]
    );

    expect(entries[0].html).toBe("<p>one</p>");
    expect(entries[0].summary).toBeUndefined();
  });

  it("does nothing for legacy boolean retrieve metadata", function () {
    var entries = [entry()];

    projectEntryFields(entries, { all_entries: true }, ["all_entries"]);

    expect(entries[0].html).toBe("<p>one</p>");
    expect(entries[0].summary).toBe("one summary");
  });

  it("does nothing for non-field access such as all_entries.length", function () {
    var entries = [entry()];

    projectEntryFields(entries, { all_entries: { length: true } }, ["all_entries"]);

    expect(entries[0].html).toBe("<p>one</p>");
  });

  it("does nothing when the local is not referenced at all", function () {
    var entries = [entry()];

    projectEntryFields(entries, { recent_entries: { fields: { title: true } } }, ["all_entries"]);

    expect(entries[0].html).toBe("<p>one</p>");
  });

  it("still projects when a kept field's markup contains Mustache tags", function () {
    var entries = [
      entry({
        id: "2",
        html: "{{#all_entries}}{{{summary}}}{{/all_entries}}",
      }),
      entry({ id: "3" }),
    ];

    projectEntryFields(
      entries,
      { all_entries: { fields: { html: true, title: true } } },
      ["all_entries"]
    );

    // Entry content is data, not a template, so tags in `html` do not keep
    // other heavy fields around for a second render pass. `html` itself stays
    // because the view references it.
    expect(entries[0].html).toBe("{{#all_entries}}{{{summary}}}{{/all_entries}}");
    expect(entries[0].summary).toBeUndefined();
    expect(entries[0].body).toBeUndefined();
    expect(entries[1].summary).toBeUndefined();
    expect(entries[1].body).toBeUndefined();
    expect(entries[1].html).toBe("<p>one</p>");
  });

  it("still projects when a retained light field contains Mustache tags", function () {
    var entries = [
      entry({ id: "2", title: "{{#all_entries}}{{summary}}{{/all_entries}}" }),
    ];

    projectEntryFields(
      entries,
      { all_entries: { fields: { title: true } } },
      ["all_entries"]
    );

    expect(entries[0].title).toBe("{{#all_entries}}{{summary}}{{/all_entries}}");
    expect(entries[0].summary).toBeUndefined();
    expect(entries[0].html).toBeUndefined();
  });

  it("projects a single entry object in place (latest_entry)", function () {
    var single = entry();

    var returned = projectEntryFields(
      single,
      { latest_entry: { fields: { title: true } } },
      ["latest_entry"]
    );

    expect(returned).toBe(single);
    expect(single.title).toEqual("One");
    expect(single.html).toBeUndefined();
    expect(single.summary).toBeUndefined();
  });

  it("leaves a single entry object untouched for legacy metadata", function () {
    var single = entry();

    projectEntryFields(single, { latest_entry: true }, ["latest_entry"]);

    expect(single.html).toBe("<p>one</p>");
  });

  it("tolerates an empty single entry object", function () {
    expect(
      projectEntryFields({}, { latest_entry: { fields: { title: true } } }, ["latest_entry"])
    ).toEqual({});
  });

  it("tolerates empty and non-array input", function () {
    expect(projectEntryFields([], { all_entries: { fields: {} } }, ["all_entries"])).toEqual(
      []
    );
    expect(projectEntryFields(undefined, {}, ["all_entries"])).toBeUndefined();
    expect(projectEntryFields([entry()], undefined, ["all_entries"])[0].html).toBe(
      "<p>one</p>"
    );
  });
});
