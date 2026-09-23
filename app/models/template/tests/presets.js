describe("template presets", function () {
  const fs = require("fs-extra");
  const path = require("path");
  const { promisify } = require("util");
  const Template = require("../index");
  const {
    validatePresets,
    presentPresets,
    applyResolvedPreset,
    toPackagePresets,
  } = require("../presets");
  const { presetMatches } = require("../preset-values");

  const create = promisify(Template.create);
  const getMetadata = promisify(Template.getMetadata);
  const readFromFolder = promisify(Template.readFromFolder);
  const writeToFolder = promisify(Template.writeToFolder);
  const drop = promisify(Template.drop);
  const savePackage = promisify(Template.package.save);
  const duplicateTemplate = require("../../../dashboard/site/template/save/duplicate-template");

  const locals = {
    background_color: "#FFFFFF",
    text_color: "#111111",
    links_color: "#111111",
    dark_background_color: "#111111",
    dark_text_color: "#ffffff",
    font: { id: "verdana", font_size: 16, line_height: 1.8, styles: "kept" },
    title_font: { id: "gill-sans", font_size: 28, line_height: 1.2 },
  };

  const presets = {
    colors: [
      {
        id: "classic",
        name: "Classic",
        values: {
          background_color: "#fff",
          text_color: "#111111",
          links_color: "rgb(17, 17, 17)",
        },
      },
      {
        id: "midnight",
        name: "Midnight",
        values: {
          background_color: "#111318",
          text_color: "#f4f4f2",
          links_color: "#8cbcff",
          dark_background_color: "#000000",
          dark_text_color: "#ffffff",
        },
      },
    ],
    fonts: [
      {
        id: "classic",
        name: "Classic",
        values: {
          font: { id: "verdana" },
          title_font: { id: "gill-sans" },
        },
      },
      {
        id: "editorial",
        name: "Editorial",
        values: {
          font: { id: "source-sans" },
          title_font: { id: "vollkorn" },
        },
      },
    ],
  };

  function isolated(value) {
    return JSON.parse(JSON.stringify(value));
  }

  global.test.blog();
  global.test.tmp();

  afterEach(async function () {
    await drop(this.blog.id, "Preset Pack").catch(function () {});
    await drop(this.blog.id, "Preset Pack copy").catch(function () {});
    await drop(this.blog.id, path.basename(this.tmp)).catch(function () {});
  });

  it("treats a template with no presets as empty metadata", function () {
    const checked = validatePresets(null, locals);
    expect(checked.errors).toEqual([]);
    expect(checked.presets).toEqual({});
    expect(toPackagePresets(undefined)).toBe(null);

    const presented = presentPresets({ locals });
    expect(presented.colors.hasPresets).toBe(false);
    expect(presented.colors.custom).toBe(null);
    expect(presented.fonts.hasPresets).toBe(false);
  });

  it("rejects a malformed preset list and unknown keys", function () {
    expect(validatePresets([], locals).errors).toContain("presets must be an object");

    const unknown = validatePresets(
      {
        colors: [
          {
            id: "bad",
            name: "Bad",
            values: { nope_color: "#fff" },
          },
        ],
        extra: [],
      },
      locals
    );

    expect(unknown.presets.colors).toBeUndefined();
    expect(unknown.errors.join("\n")).toContain("nope_color");
    expect(unknown.errors.join("\n")).toContain("presets.extra");
  });

  it("keeps the first entry when an id is duplicated", function () {
    const checked = validatePresets(
      {
        colors: [
          {
            id: "classic",
            name: "First",
            values: { background_color: "#fff" },
          },
          {
            id: "classic",
            name: "Second",
            values: { background_color: "#000" },
          },
        ],
      },
      locals
    );

    expect(checked.presets.colors.length).toBe(1);
    expect(checked.presets.colors[0].name).toBe("First");
    expect(checked.errors.join("\n")).toContain("duplicated");
  });

  it("drops dangerous keys instead of copying them onto object prototypes", function () {
    expect(Object.prototype.polluted).toBeUndefined();

    const entry = {
      id: "bad",
      name: "Bad",
      values: { background_color: "#ffffff" },
    };
    Object.defineProperty(entry.values, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const checked = validatePresets({ colors: [entry] }, locals);
    expect(checked.presets.colors).toBeUndefined();
    expect(checked.errors.join("\n")).toContain("__proto__");
    expect(Object.prototype.polluted).toBeUndefined();

    const applied = applyResolvedPreset(
      {
        locals: locals,
        presets: {
          colors: [
            {
              id: "classic",
              name: "Classic",
              values: { background_color: "#000000" },
            },
          ],
        },
      },
      "colors",
      "__proto__"
    );
    expect(applied.error).toBeDefined();
    expect(Object.prototype.polluted).toBeUndefined();
  });

  it("selects a palette whose colors match after normalization", function () {
    const presented = presentPresets({ locals, presets });
    expect(presented.errors).toEqual([]);
    expect(presented.colors.items[0].selected).toBe(true);
    expect(presented.colors.items[0].pressed).toBe("true");
    expect(presented.colors.items[1].selected).toBe(false);
    expect(presented.colors.custom.selected).toBe(false);
    expect(presented.colors.custom.hidden).toBe(true);
    expect(presetMatches({ background_color: "#fff" }, { background_color: "white" })).toBe(
      true
    );
    expect(
      presetMatches({ background_color: "#fff" }, { background_color: "#ffffff80" })
    ).toBe(false);
  });

  it("shows custom when one covered color no longer matches", function () {
    const current = Object.assign({}, locals, { text_color: "#ff00aa" });
    const presented = presentPresets({ locals: current, presets });
    expect(presented.colors.items.every((item) => !item.selected)).toBe(true);
    expect(presented.colors.custom.selected).toBe(true);
    expect(presented.colors.custom.hidden).toBe(false);
    expect(presented.colors.custom.swatches.map((swatch) => swatch.key)).toContain(
      "text_color"
    );
  });

  it("selects the first palette when two presets share values", function () {
    const presented = presentPresets({
      locals,
      presets: {
        colors: [
          { id: "first", name: "First", values: { background_color: "#FFFFFF" } },
          { id: "second", name: "Second", values: { background_color: "white" } },
        ],
      },
    });

    expect(presented.colors.items[0].selected).toBe(true);
    expect(presented.colors.items[1].selected).toBe(false);
  });

  it("omits a preset whose local is missing and keeps the valid one", function () {
    const presented = presentPresets({
      locals,
      presets: {
        colors: [
          { id: "ok", name: "Ok", values: { background_color: "#FFFFFF" } },
          { id: "gone", name: "Gone", values: { missing_color: "#fff" } },
        ],
      },
    });

    expect(presented.colors.items.map((item) => item.id)).toEqual(["ok"]);
    expect(presented.errors.join("\n")).toContain("missing_color");
  });

  it("splits light and dark colors into labeled rows", function () {
    const presented = presentPresets({ locals, presets });
    const midnight = presented.colors.items[1];
    expect(midnight.hasDark).toBe(true);
    expect(midnight.rows.map((row) => row.label)).toEqual(["Light", "Dark"]);
  });

  it("matches a font pack on the properties it declares", function () {
    const presented = presentPresets({ locals, presets });
    expect(presented.fonts.items[0].selected).toBe(true);
    expect(presented.fonts.items[0].samples.map((sample) => sample.text)).toEqual([
      "Heading",
      "Paragraph text",
    ]);

    const resized = JSON.parse(JSON.stringify(locals));
    resized.font.font_size = "18";
    const still = presentPresets({ locals: resized, presets });
    expect(still.fonts.items[0].selected).toBe(true);
    expect(presetMatches({ font: { id: "verdana", font_size: 16 } }, resized)).toBe(false);
  });

  it("disables a font pack that names an unknown font", function () {
    const presented = presentPresets({
      locals,
      presets: {
        fonts: [
          {
            id: "missing",
            name: "Missing",
            values: { font: { id: "not-a-real-font" } },
          },
        ],
      },
    });

    expect(presented.fonts.items[0].disabled).toBe(true);
    expect(presented.fonts.items[0].selected).toBe(false);
    expect(presented.fonts.items[0].error).toContain("not-a-real-font");
    expect(presented.fonts.custom.selected).toBe(true);

    const applied = applyResolvedPreset(
      {
        locals,
        presets: {
          fonts: [
            {
              id: "missing",
              name: "Missing",
              values: { font: { id: "not-a-real-font" } },
            },
          ],
        },
      },
      "fonts",
      "missing"
    );
    expect(applied.error).toContain("not-a-real-font");
    expect(applied.locals).toBeUndefined();
  });

  it("merges a font id without replacing size or line height", function () {
    const applied = applyResolvedPreset(
      { locals: isolated(locals), presets: isolated(presets) },
      "fonts",
      "editorial"
    );
    expect(applied.locals.font.id).toBe("source-sans");
    expect(applied.locals.font.font_size).toBe(16);
    expect(applied.locals.font.line_height).toBe(1.8);
    expect(applied.locals.font.styles).toBe("kept");
    expect(applied.locals.title_font.id).toBe("vollkorn");
    expect(applied.locals.title_font.font_size).toBe(28);
    expect(applied.locals.background_color).toBe("#FFFFFF");
  });

  it("applies a color palette without changing fonts", function () {
    const applied = applyResolvedPreset({ locals, presets }, "colors", "midnight");
    expect(applied.locals.background_color).toBe("#111318");
    expect(applied.locals.font.id).toBe("verdana");
    expect(applied.locals.font.font_size).toBe(16);
  });

  it("rejects an unknown preset id", function () {
    const applied = applyResolvedPreset({ locals, presets }, "colors", "nope");
    expect(applied.error).toBe("That preset is not available");
  });

  it("warns when text and background contrast is very low", function () {
    const presented = presentPresets({
      locals,
      presets: {
        colors: [
          {
            id: "pale",
            name: "Pale",
            values: { background_color: "#ffffff", text_color: "#fefefe" },
          },
        ],
      },
    });
    expect(presented.colors.items[0].warning).toContain("Low contrast");
    expect(presented.colors.items[0].ariaLabel).toContain("Low contrast");
  });

  it("selects the Blog template's classic presets", function () {
    const blog = fs.readJsonSync(
      path.join(__dirname, "../../../templates/source/blog/package.json")
    );
    const checked = validatePresets(blog.presets, blog.locals);
    expect(checked.errors).toEqual([]);

    const presented = presentPresets({ locals: blog.locals, presets: blog.presets });
    expect(presented.colors.items[0].id).toBe("classic");
    expect(presented.colors.items[0].selected).toBe(true);
    expect(presented.fonts.items.find((item) => item.id === "classic").selected).toBe(true);
    expect(presented.colors.items.map((item) => item.id)).toEqual([
      "classic",
      "midnight",
      "paper",
      "sea",
      "blush",
      "ink",
    ]);
  });

  it("round-trips presets through package generation and folder read", async function () {
    const created = await create(this.blog.id, "Preset Pack", {
      localEditing: true,
      locals: isolated(locals),
      presets: isolated(presets),
    });
    const generated = JSON.parse(Template.package.generate(this.blog.id, created, {}));
    expect(generated.presets.colors[0].id).toBe("classic");
    expect(generated.presets.fonts[1].values.font).toEqual({ id: "source-sans" });
    expect(generated.presets.colors[0].selected).toBeUndefined();

    const bare = JSON.parse(
      Template.package.generate(this.blog.id, { name: "Plain", locals: {} }, {})
    );
    expect(bare.presets).toBeUndefined();

    fs.outputJsonSync(path.join(this.tmp, "package.json"), {
      locals: { background_color: "#abcdef", text_color: "#111111" },
      presets: {
        colors: [
          {
            id: "ink",
            name: "Ink",
            values: { background_color: "#abcdef", text_color: "#111111" },
          },
          {
            id: "ink",
            name: "Duplicate",
            values: { background_color: "#000000" },
          },
        ],
      },
    });
    fs.outputFileSync(path.join(this.tmp, "index.html"), "<p>Hi</p>");

    const read = await readFromFolder(this.blog.id, this.tmp);
    expect(read.presets.colors.length).toBe(1);
    expect(read.presets.colors[0].id).toBe("ink");
    expect(read.errors["package.json"]).toContain("duplicated");

    await writeToFolder(this.blog.id, created.id);
    const writtenPath = [
      path.join(this.blogDirectory, "Templates", created.slug, "package.json"),
      path.join(this.blogDirectory, "templates", created.slug, "package.json"),
    ].find((candidate) => fs.existsSync(candidate));
    const written = fs.readJsonSync(writtenPath);
    expect(written.presets.fonts[0].name).toBe("Classic");
    expect(written.locals.background_color).toBe("#FFFFFF");
  });

  it("clears stored presets when package.json omits them", async function () {
    const created = await create(this.blog.id, "Preset Pack", {
      locals: isolated(locals),
      presets: isolated(presets),
    });
    await savePackage(created.id, { locals: { background_color: "#000000" } });
    const metadata = await getMetadata(created.id);
    expect(metadata.presets).toEqual({});
    expect(metadata.locals.background_color).toBe("#000000");
  });

  it("keeps presets when a template is cloned or duplicated", async function () {
    const source = await create(this.blog.id, "Preset Pack", {
      locals: isolated(locals),
      presets: isolated(presets),
    });
    const copy = await create(this.blog.id, "Preset Copy", { cloneFrom: source.id });
    const copied = await getMetadata(copy.id);
    expect(copied.presets.colors[1].id).toBe("midnight");
    expect(copied.presets.fonts[0].values.font.id).toBe("verdana");
    await drop(this.blog.id, "Preset Copy");

    const duplicated = await duplicateTemplate({
      owner: this.blog.id,
      template: source,
    });
    const metadata = await getMetadata(duplicated.id);
    expect(metadata.presets.colors[0].name).toBe("Classic");
    expect(metadata.locals.font.id).toBe("verdana");
  });
});
