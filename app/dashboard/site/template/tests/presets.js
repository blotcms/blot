describe("template editor presets", function () {
  const fs = require("fs");
  const path = require("path");
  const Mustache = require("mustache");
  const { promisify } = require("util");
  const Template = require("models/template");
  const presentPresets = require("models/template/presets").presentPresets;
  const loadPresets = require("../load/presets");
  const forkIfNeeded = require("../save/fork-if-needed");
  const savePreset = require("../save/preset");
  const layoutInputs = require("../save/layout-inputs");
  const persistTemplateUpdate = require("../save/persist-template-update");
  const previewReload = require("helper/publishPreviewReload");

  const create = promisify(Template.create);
  const getMetadata = promisify(Template.getMetadata);
  const drop = promisify(Template.drop);

  const viewRoot = path.join(__dirname, "../../../../views/dashboard/template");
  const readView = (name) => fs.readFileSync(path.join(viewRoot, name), "utf8");
  const sidebar = readView("template-editor-sidebar.html");
  const partials = {
    "preset-colors": readView("controls/preset-colors.html"),
    "preset-fonts": readView("controls/preset-fonts.html"),
    color: readView("controls/color.html"),
    font: readView("controls/font.html"),
  };

  const locals = {
    background_color: "#FFFFFF",
    text_color: "#111111",
    links_color: "#11111180",
    dark_background_color: "#111318",
    dark_text_color: "#f4f4f2",
    font: { id: "verdana", font_size: 16, line_height: 1.8 },
    title_font: { id: "gill-sans", font_size: 28, line_height: 1.2 },
  };

  const presets = {
    colors: [
      {
        id: "classic",
        name: "Classic",
        values: {
          background_color: "#FFFFFF",
          text_color: "#111111",
          links_color: "#11111180",
          dark_background_color: "#111318",
          dark_text_color: "#f4f4f2",
        },
      },
      {
        id: "midnight",
        name: "A very long palette name that should stay available to assistive technology",
        values: {
          background_color: "#111318",
          text_color: "#f4f4f2",
          links_color: "#8cbcff",
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
      {
        id: "missing",
        name: "Missing",
        values: {
          font: { id: "not-a-real-font" },
          title_font: { id: "gill-sans" },
        },
      },
    ],
  };

  function render(view) {
    return Mustache.render(sidebar, view, partials);
  }

  function colorInputs() {
    return [
      { key: "background_color", label: "Background", value: locals.background_color },
      { key: "text_color", label: "Text", value: locals.text_color },
    ];
  }

  function fontInputs() {
    return [
      {
        key: "font",
        label: "Body",
        value: { id: "verdana", name: "Verdana", stack: "Verdana, sans-serif" },
        font_size: 16,
        line_height: 1.8,
      },
    ];
  }

  global.test.blog();

  beforeEach(function () {
    spyOn(previewReload, "publish").and.returnValue(Promise.resolve());
  });

  afterEach(async function () {
    await drop(this.blog.id, "Owned Presets").catch(function () {});
    await drop("SITE", "Preset Source").catch(function () {});
  });

  it("keeps the precise controls when a template has no presets", function () {
    const html = render({
      base: "/sites/demo/template/plain",
      csrftoken: "token",
      colors: colorInputs(),
      fonts: fontInputs(),
    });

    expect(html).not.toContain("Color palettes");
    expect(html).not.toContain("Font packs");
    expect(html).toContain("Colors");
    expect(html).toContain('class="color-picker"');
    expect(html).toContain("data-font-picker-form");
    expect(html).not.toContain("preset-edit");
  });

  it("renders palette and font cards with edit disclosures", function () {
    const presented = presentPresets({ locals, presets });
    const html = render({
      base: "/sites/demo/template/blog",
      csrftoken: "token",
      colors: colorInputs(),
      fonts: fontInputs(),
      colorPresets: presented.colors,
      fontPresets: presented.fonts,
      presetFontStyles: presented.fontStyles,
    });

    expect(html).toContain("Color palettes");
    expect(html).toContain("Font packs");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="preset-colors-controls"');
    expect(html).toContain('data-preset-controls hidden');
    expect(html).toContain("preset-check");
    expect(html).toContain('action="/sites/demo/template/blog/preset"');
    expect(html).toContain('name="preset.type" value="colors"');
    expect(html).toContain('name="preset.id" value="classic"');
    expect(html).not.toContain('value="custom"');

    const customAt = html.indexOf('data-preset-custom="colors"');
    expect(html.slice(customAt - 120, customAt)).toContain("<div");
    expect(html.slice(customAt - 40, customAt)).not.toContain("<button");
    expect(html).toContain("Light");
    expect(html).toContain("Dark");
    expect(html).toContain("background:#11111180");
    expect(html).toContain(
      "A very long palette name that should stay available to assistive technology"
    );
    expect(html).toContain("Unknown font");
    expect(html).toContain("disabled");
    expect(html).toContain("Heading");
    expect(html).toContain("Paragraph text");
    expect(html).toContain('data-preset-fonts');
    expect(html).toContain('name="locals.background_color"');
  });

  it("renders one preset with an edit disclosure and a custom state", function () {
    const presented = presentPresets({
      locals: Object.assign({}, locals, { background_color: "#123456" }),
      presets: {
        colors: [
          {
            id: "only",
            name: "Only",
            values: { background_color: "#ffffff" },
          },
        ],
      },
    });
    const html = render({
      base: "/sites/demo/template/blog",
      csrftoken: "token",
      colors: colorInputs(),
      colorPresets: presented.colors,
      fontPresets: { hasPresets: false },
      fonts: fontInputs(),
    });

    expect(html).toContain("Edit colors");
    expect(html).toContain('name="preset.id" value="only"');
    expect(html).toContain('data-preset-custom="colors"');
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain("Font packs");
    expect(html).toContain("data-font-picker-form");
  });

  it("exposes the derived selection on the template route", function () {
    const req = { template: { locals, presets } };
    const res = { locals: {} };
    loadPresets(req, res, function () {});
    expect(res.locals.colorPresets.items[0].selected).toBe(true);
    expect(res.locals.fontPresets.items.find((item) => item.id === "missing").disabled).toBe(
      true
    );
    expect(res.locals.presetFontStyles).toEqual(jasmine.any(String));
  });

  it("uses a single column for font cards before the samples get cramped", function () {
    const css = fs.readFileSync(
      path.join(viewRoot, "css/presets.css"),
      "utf8"
    );
    expect(css).toContain("repeat(auto-fit, minmax(5.5rem, 1fr))");
    expect(css).toContain("repeat(auto-fit, minmax(9.5rem, 1fr))");
    expect(css).toContain(".preset-tile:focus-visible");
    expect(css).toContain(".preset-tile.is-selected .preset-check");
  });

  function response() {
    const res = {
      locals: {},
      headers: {},
      statusCode: 200,
      body: undefined,
      set(key, value) {
        this.headers[key] = value;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(body) {
        this.body = body;
        if (this._resolve) this._resolve(this);
        return this;
      },
      end() {
        if (this._resolve) this._resolve(this);
        return this;
      },
      message(url, text) {
        this.messageUrl = url;
        this.messageText = text;
        if (this._resolve) this._resolve(this);
      },
    };
    res.done = new Promise((resolve, reject) => {
      res._resolve = resolve;
      res._reject = reject;
    });
    return res;
  }

  function apply(req, res) {
    forkIfNeeded(req, res, function (err) {
      if (err) return res._reject(err);
      savePreset(req, res, function (err) {
        if (err) return res._reject(err);
        layoutInputs(req, res, function (err) {
          if (err) return res._reject(err);
          persistTemplateUpdate(req, res, function (err) {
            if (err) return res._reject(err);
          });
        });
      });
    });
    return res.done;
  }

  it("applies a color preset and publishes a preview reload", async function () {
    const template = await create(this.blog.id, "Owned Presets", {
      locals: locals,
      presets: presets,
    });

    const res = response();
    const req = {
      blog: this.blog,
      template: await getMetadata(template.id),
      params: { templateSlug: "owned-presets" },
      body: { "preset.type": "colors", "preset.id": "midnight" },
      query: { ajax: "true" },
      baseUrl: "/sites/demo/template",
      url: "/owned-presets/preset",
    };

    const result = await apply(req, res);
    expect(result.statusCode).toBe(204);
    expect(previewReload.publish).toHaveBeenCalledWith(this.blog.id);

    const saved = await getMetadata(template.id);
    expect(saved.locals.background_color).toBe("#111318");
    expect(saved.locals.text_color).toBe("#f4f4f2");
    expect(saved.locals.links_color).toBe("#8cbcff");
    expect(saved.locals.font.id).toBe("verdana");
    expect(saved.locals.font.font_size).toBe(16);
    expect(saved.presets.colors[0].id).toBe("classic");
  });

  it("applies a font id and keeps the current size and line height", async function () {
    const template = await create(this.blog.id, "Owned Presets", {
      locals: locals,
      presets: {
        fonts: [
          {
            id: "editorial",
            name: "Editorial",
            values: {
              font: { id: "source-sans" },
              title_font: { id: "vollkorn" },
            },
          },
        ],
      },
    });

    const res = response();
    await apply(
      {
        blog: this.blog,
        template: await getMetadata(template.id),
        params: { templateSlug: "owned-presets" },
        body: { preset: { type: "fonts", id: "editorial" } },
        query: { ajax: "true" },
        baseUrl: "/sites/demo/template",
        url: "/owned-presets/preset",
      },
      res
    );

    const saved = await getMetadata(template.id);
    expect(saved.locals.font.id).toBe("source-sans");
    expect(saved.locals.font.font_size).toBe(16);
    expect(saved.locals.font.line_height).toBe(1.8);
    expect(saved.locals.title_font.id).toBe("vollkorn");
    expect(saved.locals.title_font.font_size).toBe(28);
    expect(saved.locals.background_color).toBe("#FFFFFF");
  });

  it("rejects an unknown preset without changing locals", async function () {
    const template = await create(this.blog.id, "Owned Presets", {
      locals: locals,
      presets: presets,
    });
    const res = response();
    const req = {
      blog: this.blog,
      template: await getMetadata(template.id),
      params: { templateSlug: "owned-presets" },
      body: { "preset.type": "colors", "preset.id": "no-such-palette" },
      query: { ajax: "true" },
      baseUrl: "/sites/demo/template",
      url: "/owned-presets/preset",
    };

    await apply(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("not available");
    const saved = await getMetadata(template.id);
    expect(saved.locals.background_color).toBe("#FFFFFF");
    expect(previewReload.publish).not.toHaveBeenCalled();
  });

  it("forks a stock template before applying a preset", async function () {
    const source = await create("SITE", "Preset Source", {
      isPublic: true,
      locals: locals,
      presets: presets,
    });
    this.blog.template = source.id;

    const res = response();
    const req = {
      blog: this.blog,
      template: await getMetadata(source.id),
      params: { templateSlug: "preset-source" },
      body: { "preset.type": "colors", "preset.id": "midnight" },
      query: { ajax: "true" },
      baseUrl: "/sites/demo/template",
      url: "/preset-source/preset",
    };

    const result = await apply(req, res);
    expect(result.headers["X-Template-Forked"]).toBe("1");

    const forked = await getMetadata(this.blog.id + ":preset-source");
    expect(forked.locals.background_color).toBe("#111318");
    expect(forked.presets.fonts[0].id).toBe("classic");
    expect(forked.owner).toBe(this.blog.id);

    const untouched = await getMetadata(source.id);
    expect(untouched.locals.background_color).toBe("#FFFFFF");
    await drop(this.blog.id, "Preset Source");
  });

  it("writes the preset into package.json for a locally edited template", async function () {
    const template = await create(this.blog.id, "Owned Presets", {
      localEditing: true,
      locals: locals,
      presets: presets,
    });

    const res = response();
    await apply(
      {
        blog: this.blog,
        template: await getMetadata(template.id),
        params: { templateSlug: "owned-presets" },
        body: { "preset.type": "colors", "preset.id": "midnight" },
        query: {},
        baseUrl: "/sites/demo/template",
        url: "/owned-presets/preset",
      },
      res
    );

    expect(res.messageText).toBe("Success!");
    const writtenPath = [
      path.join(this.blogDirectory, "Templates", "owned-presets", "package.json"),
      path.join(this.blogDirectory, "templates", "owned-presets", "package.json"),
    ].find((candidate) => fs.existsSync(candidate));

    const written = JSON.parse(fs.readFileSync(writtenPath, "utf8"));
    expect(written.locals.background_color).toBe("#111318");
    expect(written.presets.colors.map((entry) => entry.id)).toEqual([
      "classic",
      "midnight",
    ]);
  });
});
