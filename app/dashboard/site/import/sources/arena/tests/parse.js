const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const parse = require("../parse");

describe("Are.na text block importer", function () {
  let outputDirectory;

  beforeEach(function () {
    outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "arena-import-"));
  });

  afterEach(function () {
    fs.removeSync(outputDirectory);
  });

  function block(overrides) {
    return Object.assign(
      {
        id: 123,
        class: "Text",
        title: "A text block",
        content:
          '<p>Hello <strong>world</strong>. Visit <a href="https://example.com">Example</a>.</p>',
        visibility: "public",
        created_at: "2020-04-05T06:07:08.000Z",
        updated_at: "2021-05-06T07:08:09.000Z",
      },
      overrides
    );
  }

  it("converts formatted HTML and preserves timestamps and source metadata", async function () {
    const item = block({ description: "A useful description" });
    await parse({ outputDirectory, posts: [item], status: function () {} });

    const destination = path.join(
      outputDirectory,
      "2020",
      "04-05-A-text-block.txt"
    );
    const content = fs.readFileSync(destination, "utf8");
    expect(content).toContain("Date: 2020-04-05");
    expect(content).toContain("Link: https://www.are.na/block/123");
    expect(content).toContain("Summary: A useful description");
    expect(content).toContain("Hello **world**.");
    expect(content).toContain("[Example](https://example.com)");
    const normalized = parse.normalizeText(item);
    expect(normalized.dateStamp).toBe(Date.parse(item.created_at));
    expect(normalized.created).toBe(Date.parse(item.created_at));
    expect(normalized.updated).toBe(Date.parse(item.updated_at));
  });

  it("places private blocks in Drafts and applies both title fallbacks", async function () {
    await parse({
      outputDirectory,
      status: function () {},
      posts: [
        block({
          id: 1,
          title: "",
          generated_title: "Generated",
          visibility: "private",
        }),
        block({
          id: 2,
          title: "",
          generated_title: "",
          created_at: "2020-04-06T00:00:00Z",
        }),
      ],
    });

    expect(
      fs.existsSync(path.join(outputDirectory, "Drafts", "Generated.txt"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(outputDirectory, "2020", "04-06-Untitled.txt"))
    ).toBe(true);
  });

  it("uses stable suffixes for duplicate titles", async function () {
    await parse({
      outputDirectory,
      status: function () {},
      posts: [
        block({ content: "first" }),
        block({ id: 456, content: "second" }),
      ],
    });

    const directory = path.join(outputDirectory, "2020");
    expect(
      fs.readFileSync(path.join(directory, "04-05-A-text-block.txt"), "utf8")
    ).toContain("first");
    expect(
      fs.readFileSync(path.join(directory, "04-05-A-text-block-2.txt"), "utf8")
    ).toContain("second");
  });

  it("reports unsupported and malformed blocks, then imports later blocks", async function () {
    const statuses = [];
    spyOn(console, "error");
    await parse({
      outputDirectory,
      status: (message) => statuses.push(message),
      posts: [
        { id: 10, class: "Attachment", title: "Unsupported" },
        block({ id: 11, title: "Malformed", content: undefined }),
        block({ id: 12, title: "Still imported", content: "Success" }),
      ],
    });

    expect(
      statuses.some((message) =>
        message.includes("Cannot process Are.na block Unsupported")
      )
    ).toBe(true);
    expect(
      statuses.some((message) =>
        message.includes("Failed to process Are.na block Malformed")
      )
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(outputDirectory, "2020", "04-05-Still-imported.txt"),
        "utf8"
      )
    ).toContain("Success");
  });
});
