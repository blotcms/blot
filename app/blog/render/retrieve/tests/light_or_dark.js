describe("light_or_dark", function () {
  var light_or_dark = require("blog/render/retrieve/light_or_dark");
  var mustache = require("mustache");

  async function render(template, view = {}) {
    const lambda = await light_or_dark({}, {});
    return mustache.render(template, { ...view, light_or_dark: lambda });
  }

  it("returns dark for a dark colour", async function () {
    expect(await render("{{#light_or_dark}}#000{{/light_or_dark}}")).toEqual(
      "dark"
    );
    expect(await render("{{#light_or_dark}}#1a1a2e{{/light_or_dark}}")).toEqual(
      "dark"
    );
  });

  it("returns light for a light colour", async function () {
    expect(await render("{{#light_or_dark}}#fff{{/light_or_dark}}")).toEqual(
      "light"
    );
    expect(await render("{{#light_or_dark}}#f4f1ea{{/light_or_dark}}")).toEqual(
      "light"
    );
  });

  it("reads rgb, rgba and named colours", async function () {
    expect(
      await render("{{#light_or_dark}}rgb(20, 20, 20){{/light_or_dark}}")
    ).toEqual("dark");
    expect(
      await render(
        "{{#light_or_dark}}rgba(250, 250, 250, 0.5){{/light_or_dark}}"
      )
    ).toEqual("light");
    expect(await render("{{#light_or_dark}}navy{{/light_or_dark}}")).toEqual(
      "dark"
    );
    expect(await render("{{#light_or_dark}}white{{/light_or_dark}}")).toEqual(
      "light"
    );
  });

  it("splits at a perceived brightness of 128", async function () {
    // (299 * 127 + 587 * 127 + 114 * 127) / 1000 = 127, then 128 for #808080
    expect(await render("{{#light_or_dark}}#7f7f7f{{/light_or_dark}}")).toEqual(
      "dark"
    );
    expect(await render("{{#light_or_dark}}#808080{{/light_or_dark}}")).toEqual(
      "light"
    );
  });

  it("weighs green above red and blue, as the eye does", async function () {
    expect(await render("{{#light_or_dark}}#0000ff{{/light_or_dark}}")).toEqual(
      "dark"
    );
    expect(await render("{{#light_or_dark}}#00ff00{{/light_or_dark}}")).toEqual(
      "light"
    );
  });

  it("renders a local passed inside it", async function () {
    expect(
      await render("{{#light_or_dark}}{{background_color}}{{/light_or_dark}}", {
        background_color: "#000000",
      })
    ).toEqual("dark");
  });

  it("ignores whitespace around the colour", async function () {
    expect(
      await render("{{#light_or_dark}}\n  #ffffff \n{{/light_or_dark}}")
    ).toEqual("light");
  });

  it("returns nothing for a value that isn't a colour", async function () {
    expect(
      await render("{{#light_or_dark}}not a colour{{/light_or_dark}}")
    ).toEqual("");
    expect(await render("{{#light_or_dark}}{{/light_or_dark}}")).toEqual("");
    expect(
      await render("{{#light_or_dark}}{{background_color}}{{/light_or_dark}}")
    ).toEqual("");
  });
});
