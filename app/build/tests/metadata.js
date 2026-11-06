describe("metadata parser", function () {
  var Metadata = require("../metadata");

  it("parses metadata", function () {
    expect(
      Metadata(
        ["Page:yes", "Permalink:", "Date: 12/10/12", "", "# Hi"].join("\n")
      ).metadata
    ).toEqual({
      Page: "yes",
      Permalink: "",
      Date: "12/10/12",
    });
  });

  it("parses metadata with Windows newlines", function () {
    expect(
      Metadata(
        ["Page:yes", "Permalink:", "Date: 12/10/12", "", "# Hi"].join("\r\n")
      ).metadata
    ).toEqual({
      Page: "yes",
      Permalink: "",
      Date: "12/10/12",
    });
  });

  it("parses metadata with non-standard return character newlines", function () {
    expect(
      Metadata(
        ["Page:yes", "Permalink:", "Date: 12/10/12", "", "# Hi"].join("\r")
      ).metadata
    ).toEqual({
      Page: "yes",
      Permalink: "",
      Date: "12/10/12",
    });
  });

  it("parses YAML metadata", function () {
    expect(
      Metadata(
        ["---", "Page: yes", "Permalink: hey", "---", "", "# Hi"].join("\n")
      ).metadata
    ).toEqual({
      Page: "yes",
      Permalink: "hey",
    });
  });

  it("parses empty YAML metadata", function () {
    expect(
      Metadata(["---", "Summary: ", "---", "", "# Hi"].join("\n")).metadata
    ).toEqual({
      Summary: "",
    });
  });

  it("parses arrays in YAML metadata", function () {
    expect(
      Metadata(
        ["---", "Tags:", "  - one", "  - two", "---", "", "# Hi"].join("\n")
      ).metadata
    ).toEqual({
      Tags: ["one", "two"],
    });
  });

  it("parses empty metadata", function () {
    expect(Metadata(["Summary: ", "", "# Hi"].join("\n")).metadata).toEqual({
      Summary: "",
    });
  });

  it("handles colons", function () {
    expect(
      Metadata(
        ["Author:me", "", "What about a colon in the next line: yes you."].join(
          "\n"
        )
      ).metadata
    ).toEqual({
      Author: "me",
    });
  });

  it("stops parsing when a line lacks a colon", function () {
    expect(
      Metadata(["Author:me", "Hey", "Date: 1"].join("\n")).metadata
    ).toEqual({
      Author: "me",
    });
  });

  it("handles spaces in the metadata key", function () {
    expect(Metadata(["Author name: Jason"].join("\n")).metadata).toEqual({
      "Author name": "Jason",
    });
  });

  it("allows a maximum of one space in the metadata key", function () {
    expect(Metadata(["And he called: Jason"].join("\n")).metadata).toEqual({});
  });

  it("allows dashes in the metadata key", function () {
    expect(Metadata(["Is-Social: Yes"].join("\n")).metadata).toEqual({
      "Is-Social": "Yes",
    });
  });

  it("allows underscores in the metadata key", function () {
    expect(Metadata(["Is_Social: Yes"].join("\n")).metadata).toEqual({
      Is_Social: "Yes",
    });
  });

  it("disallows punctuation in the metadata key", function () {
    expect(Metadata(["Lo! Said: Jason"].join("\n")).metadata).toEqual({});
  });

  it("handles pure metadata", function () {
    expect(Metadata(["only:metadata", "in:this"].join("\n")).metadata).toEqual({
      only: "metadata",
      in: "this",
    });
  });

  it("ignores a title with a colon", function () {
    expect(
      Metadata(
        [
          "# Since the title: is on the first line, no metada should be extracted",
          "Date: 1",
        ].join("\n")
      ).metadata
    ).toEqual({});
  });

  it("does not interpret a URL as a metadata key", function () {
    expect(
      Metadata(["<a href='/'>http://example.com</a>"].join("\n")).metadata
    ).toEqual({});
  });

  it("parses a URL as a metadata value", function () {
    expect(
      Metadata(["Thumbnail: http://example.com/image.jpg"].join("\n")).metadata
    ).toEqual({
      Thumbnail: "http://example.com/image.jpg",
    });
  });
});
