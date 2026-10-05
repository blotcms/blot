describe("prepare", function () {
  var prepare = require("../index");

  beforeEach(function () {
    this.entry = {
      path: "",
      size: 123,
      html: "",
      updated: 123,
      draft: true,
      metadata: {},
    };
  });

  // This was the result of a rather niche bug, caused by files like this:
  // Title:
  // Hello world!
  // Blot was generating an empty title *and* an empty empty summary, since
  // 'Hello world!' was in the auto-generated title but not the metadata
  // title. The summary generated is now passed the metadata title too...
  it("includes what would become the title, in the summary, if the title is set to empty in the file's metadata", function () {
    var entry = this.entry;

    entry.html = "<p>Hey there.</p>";
    entry.metadata = {
      title: "",
    };

    prepare(entry);

    expect(entry.title).toEqual("");
    expect(entry.summary).toEqual("Hey there");
  });

  it("will not remove non-h1 title tags from the body", function () {
    var entry = this.entry;

    entry.html = "<p>Bar bat.</p><h3>How</h3><p>Now</p>";
    entry.metadata = {
      title: "Foo",
    };

    prepare(entry);

    expect(entry.title).toEqual("Foo");
    expect(entry.body).toEqual(entry.html);
    expect(entry.body).toEqual("<p>Bar bat.</p><h3>How</h3><p>Now</p>");
  });

  it("will generate a title from an ampersand", function () {
    var entry = this.entry;

    entry.html = "<p>&amp;</p>";

    prepare(entry);

    expect(entry.title).toEqual("&");
    expect(entry.body).toEqual(entry.html);
  });


  it("uses mixed-case metadata keys for page, menu and permalink", function () {
    var entry = this.entry;

    entry.path = "/post.txt";
    entry.html = "<p>Hello there</p>";
    entry.draft = false;
    entry.metadata = {
      Page: "yes",
      MENU: "no",
      Permalink: "/mixed-case"
    };

    prepare(entry);

    expect(entry.page).toEqual(true);
    expect(entry.menu).toEqual(false);
    expect(entry.permalink).toEqual("/mixed-case");
  });



  it("overwrites titleTag from canonical metadata key", function () {
    var entry = this.entry;

    entry.html = "<h1>Generated title</h1><p>Body</p>";
    entry.metadata = {
      titleTag: "Metadata title tag"
    };

    prepare(entry);

    expect(entry.titleTag).toEqual("Metadata title tag");
  });

  it("overwrites titleTag from mixed-case metadata key", function () {
    var entry = this.entry;

    entry.html = "<h1>Generated title</h1><p>Body</p>";
    entry.metadata = {
      TitleTag: "Mixed case metadata title tag"
    };

    prepare(entry);

    expect(entry.titleTag).toEqual("Mixed case metadata title tag");
  });

  it("overwrites teaserBody from metadata", function () {
    var entry = this.entry;

    entry.html = "<p>Generated teaser body</p>";
    entry.metadata = {
      teaserBody: "Metadata teaser body"
    };

    prepare(entry);

    expect(entry.teaserBody).toEqual("Metadata teaser body");
  });

  it("lists the markup fields front matter overwrites, ignoring text fields and case", function () {
    expect(
      prepare.overriddenMarkupFields({
        Teaser: "<p>Teaser</p>",
        teaserBody: "<p>Body</p>",
        body: "<p>Whole</p>",
        summary: "Summary",
        title: "Title",
        other: "<p>Unrelated</p>",
      }).sort()
    ).toEqual(["body", "teaser", "teaserBody"]);

    expect(prepare.overriddenMarkupFields({ summary: "Only text" })).toEqual([]);
    // overrides must be strings, like the model's fields
    expect(prepare.overriddenMarkupFields({ teaser: 5 })).toEqual([]);
  });

  it("generates an empty title when given an empty file", function () {
    var entry = this.entry;

    entry.html = "";

    prepare(entry);

    expect(entry.title).toEqual("");
  });
});
