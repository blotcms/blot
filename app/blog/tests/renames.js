describe("blog handles renames", function () {
  require("./util/setup")();

  const parseSlugDatestamps = (text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((acc, line) => {
        const [slug, datestamp] = line.split("=");
        acc[slug] = datestamp;
        return acc;
      }, {});

  it("will detect a renamed entry", async function () {
    await this.template({
      "entries.html": "{{#entries}}{{dateStamp}}{{/entries}}",
    });

    const now = Date.now();

    await this.write({ path: "/first.txt", content: "# Hey\n\nFoo bar baz" });

    const firstDatestamp = await this.text(`/`);

    expect(parseInt(firstDatestamp)).toBeGreaterThanOrEqual(now);

    await this.remove("/first.txt");

    expect(await this.text(`/`)).toEqual("");

    await this.write({
      path: "/renamed.txt",
      content: "# Hey\n\nFoo bar baz",
    });

    const renamedDatestamp = await this.text(`/`);

    expect(renamedDatestamp).toEqual(firstDatestamp);
  });

  it("reuses datestamps for renames with unusual paths", async function () {
    await this.template({
      "entries.html": "{{#entries}}{{slug}}={{dateStamp}}\n{{/entries}}",
    });

    const originalPath = "/Folder/Sub folder & symbols — test!.txt";
    await this.write({
      path: originalPath,
      content: "# Unusual\n\nTesting unusual paths",
    });

    const initialMap = parseSlugDatestamps(await this.text(`/`));

    const [originalSlug, originalDatestamp] = Object.entries(initialMap)[0];

    await this.remove(originalPath);

    expect(parseSlugDatestamps(await this.text(`/`))).toEqual({});

    const renamedPath = "/Another folder/📝 notes & stuff.md";
    await this.write({
      path: renamedPath,
      content: "# Unusual\n\nTesting unusual paths",
    });

    const renamedMap = parseSlugDatestamps(await this.text(`/`));
    const [renamedSlug, renamedDatestamp] = Object.entries(renamedMap)[0];

    expect(renamedSlug).toEqual(originalSlug);
    expect(renamedDatestamp).toEqual(originalDatestamp);
  });

  it("reuses datestamps for delayed renames after other writes", async function () {
    await this.template({
      "entries.html": "{{#entries}}{{slug}}={{dateStamp}}\n{{/entries}}",
    });

    await this.write({
      path: "/delayed-entry.txt",
      content: "# Delayed\n\nOriginal content",
    });

    await this.write({
      path: "/other-entry.txt",
      content: "# Other\n\nSeparate entry",
    });

    const initialMap = parseSlugDatestamps(await this.text(`/`));
    const originalDatestamp = initialMap["delayed-entry"];
    const otherDatestamp = initialMap["other-entry"];

    await this.remove("/delayed-entry.txt");

    await new Promise((resolve) => setTimeout(resolve, 25));

    await this.write({
      path: "/intermediate-entry.txt",
      content: "# Intermediate\n\nAnother entry during delay",
    });

    await this.write({
      path: "/renamed-delayed-entry.txt",
      content: "# Delayed\n\nOriginal content",
    });

    const renamedMap = parseSlugDatestamps(await this.text(`/`));

    expect(renamedMap["renamed-delayed-entry"]).toEqual(originalDatestamp);
    expect(renamedMap["other-entry"]).toEqual(otherDatestamp);
  });

  it("updates a deduplicated url when a rename causes both files to exist at once", async function () {
    await this.template({
      "entry.html": "{{{entry.title}}}",
    });

    await this.write({
      path: "/entry.txt",
      content: "Link: /entry\nTitle: Original\n\nContent",
    });

    expect(await this.text(`/entry`)).toBe("Original");

    await this.write({
      path: "/entryrenamed.txt",
      content: "Link: /entry\nTitle: Renamed\n\nContent",
    });

    expect(await this.text(`/entry`)).toBe("Original");
    expect(await this.text(`/entry-2`)).toBe("Renamed");

    await this.remove("/entry.txt");

    expect(await this.text(`/entry`)).toBe("Renamed");
    expect(await this.text(`/entry-2`)).toBe("Renamed");
  });
});
