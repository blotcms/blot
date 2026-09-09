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

    projectEntryFields(entries, { allEntries: { fields: { title: true, url: true } } }, [
      "allEntries",
      "all_entries",
    ]);

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
      { allEntries: { fields: { html: true, title: true } } },
      ["allEntries", "all_entries"]
    );

    expect(entries[0].html).toBe("<p>one</p>");
    expect(entries[0].summary).toBeUndefined();
  });

  it("resolves fields from an aliased retrieve key", function () {
    var entries = [entry()];

    projectEntryFields(entries, { all_entries: { fields: { title: true } } }, [
      "allEntries",
      "all_entries",
    ]);

    expect(entries[0].html).toBeUndefined();
  });

  it("unions referenced fields across aliases", function () {
    var entries = [entry()];

    projectEntryFields(
      entries,
      {
        allEntries: { fields: { title: true } },
        all_entries: { fields: { html: true } },
      },
      ["allEntries", "all_entries"]
    );

    expect(entries[0].html).toBe("<p>one</p>");
    expect(entries[0].teaser).toBeUndefined();
  });

  it("does nothing for legacy boolean retrieve metadata", function () {
    var entries = [entry()];

    projectEntryFields(entries, { allEntries: true }, ["allEntries", "all_entries"]);

    expect(entries[0].html).toBe("<p>one</p>");
    expect(entries[0].summary).toBe("one summary");
  });

  it("does nothing for non-field access such as allEntries.length", function () {
    var entries = [entry()];

    projectEntryFields(entries, { allEntries: { length: true } }, [
      "allEntries",
      "all_entries",
    ]);

    expect(entries[0].html).toBe("<p>one</p>");
  });

  it("does nothing when the local is not referenced at all", function () {
    var entries = [entry()];

    projectEntryFields(entries, { recentEntries: { fields: { title: true } } }, [
      "allEntries",
      "all_entries",
    ]);

    expect(entries[0].html).toBe("<p>one</p>");
  });

  it("is conservative when one of several aliases lacks field metadata", function () {
    var entries = [entry()];

    projectEntryFields(
      entries,
      { allEntries: { fields: { title: true } }, all_entries: true },
      ["allEntries", "all_entries"]
    );

    expect(entries[0].html).toBe("<p>one</p>");
  });

  it("skips projection for the whole list when a kept field's markup contains Mustache", function () {
    var entries = [
      entry({
        id: "2",
        html: "{{#allEntries}}{{{summary}}}{{/allEntries}}",
      }),
      entry({ id: "3" }),
    ];

    projectEntryFields(
      entries,
      { allEntries: { fields: { html: true, title: true } } },
      ["allEntries", "all_entries"]
    );

    // The dynamic markup in entry 0 is rendered against the whole list, so
    // every entry keeps all heavy fields - not just the one holding the tags.
    expect(entries[0].summary).toBe("one summary");
    expect(entries[0].body).toBe("one");
    expect(entries[1].summary).toBe("one summary");
    expect(entries[1].body).toBe("one");
    expect(entries[1].html).toBe("<p>one</p>");
  });

  it("skips projection when a retained light field contains Mustache", function () {
    var entries = [
      entry({ id: "2", title: "{{#allEntries}}{{summary}}{{/allEntries}}" }),
    ];

    projectEntryFields(
      entries,
      { allEntries: { fields: { title: true } } },
      ["allEntries", "all_entries"]
    );

    // `title` is kept (referenced) but its Mustache is re-rendered against the
    // whole local, so `summary` etc. must not be stripped.
    expect(entries[0].summary).toBe("one summary");
    expect(entries[0].html).toBe("<p>one</p>");
  });

  it("still projects when Mustache only appears in a field being stripped", function () {
    var entries = [
      entry({ id: "2", body: "{{#allEntries}}{{summary}}{{/allEntries}}" }),
    ];

    projectEntryFields(
      entries,
      { allEntries: { fields: { title: true } } },
      ["allEntries", "all_entries"]
    );

    // `body` is being removed anyway, so its contents don't block projection.
    expect(entries[0].body).toBeUndefined();
    expect(entries[0].summary).toBeUndefined();
    expect(entries[0].html).toBeUndefined();
  });

  it("projects a single entry object in place (latestEntry)", function () {
    var single = entry();

    var returned = projectEntryFields(
      single,
      { latestEntry: { fields: { title: true } } },
      ["latestEntry", "latest_entry"]
    );

    expect(returned).toBe(single);
    expect(single.title).toEqual("One");
    expect(single.html).toBeUndefined();
    expect(single.summary).toBeUndefined();
  });

  it("leaves a single entry object untouched for legacy metadata", function () {
    var single = entry();

    projectEntryFields(single, { latestEntry: true }, ["latestEntry"]);

    expect(single.html).toBe("<p>one</p>");
  });

  it("tolerates an empty single entry object", function () {
    expect(
      projectEntryFields({}, { latestEntry: { fields: { title: true } } }, [
        "latestEntry",
      ])
    ).toEqual({});
  });

  it("tolerates empty and non-array input", function () {
    expect(projectEntryFields([], { allEntries: { fields: {} } }, ["allEntries"])).toEqual(
      []
    );
    expect(projectEntryFields(undefined, {}, ["allEntries"])).toBeUndefined();
    expect(projectEntryFields([entry()], undefined, ["allEntries"])[0].html).toBe(
      "<p>one</p>"
    );
  });
});
