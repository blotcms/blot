const renderPluginAssets = require("../renderPluginAssets");

describe("renderPluginAssets", function () {
  const googleAnalytics = [
    "{{#plugins.analytics.options.provider.Google}}",
    "var GAID = '{{plugins.analytics.options.trackingID}}';",
    "{{/plugins.analytics.options.provider.Google}}",
    "{{#plugins.analytics.options.provider.Plausible}}",
    "plausible.io",
    "{{/plugins.analytics.options.provider.Plausible}}",
  ].join("");

  it("leaves strings without tags unchanged", function () {
    expect(renderPluginAssets(".katex{}", { blog: { plugins: {} } }, {})).toEqual(
      ".katex{}"
    );
  });

  it("renders analytics tags against the blog's plugin options", function () {
    const result = renderPluginAssets(googleAnalytics, {
      blog: {
        plugins: {
          analytics: {
            enabled: true,
            options: { provider: { Google: true }, trackingID: "UA-1" },
          },
        },
      },
    }, {});

    expect(result).toContain("var GAID = 'UA-1';");
    expect(result).not.toContain("plausible.io");
    expect(result).not.toContain("{{");
  });

  it("prefers plugins already on res.locals over req.blog.plugins", function () {
    const result = renderPluginAssets("{{plugins.analytics.options.trackingID}}", {
      blog: {
        plugins: {
          analytics: { options: { trackingID: "from-blog" } },
        },
      },
    }, {
      locals: {
        plugins: { analytics: { options: { trackingID: "from-locals" } } },
      },
    });

    expect(result).toEqual("from-locals");
  });

  it("returns the source if rendering throws", function () {
    const broken = "Hello {{> missing}";
    expect(renderPluginAssets(broken, { blog: { plugins: {} } }, {})).toEqual(
      broken
    );
  });
});
