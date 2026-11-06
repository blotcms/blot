describe("pluginHTML", function () {
  require("./util/setup")();
  const config = require("config");

  it("injects disqus html", async function () {
    // enable the disqus plugin
    const shortname = "test";
    const plugins = {
      ...this.blog.plugins,
      disqus: { enabled: true, options: { shortname } },
    };
    await this.blog.update({ plugins });

    await this.template({ "entry.html": "{{{entry.html}}} {{> pluginHTML}}" });
    await this.write({
      path: "/a.txt",
      content: "Link: /foo\nDisqus: mixed-case-disqus-id\n\nHello, world!",
    });
    await this.write({
      path: "/Pages/about.txt",
      content: "Link: /about\n\nHello, world!",
    });
    await this.write({ path: "/Drafts/test.txt", content: "Hello, draft!" });

    const areThereComments = async (path) => {
      const body = await this.text(path);
      return (
        body.includes('<div id="disqus_thread"></div>') &&
        body.includes("disqus.com/embed.js")
      );
    };

    expect(await areThereComments("/foo")).toBe(
      true,
      "comments should appear on posts"
    );

    const fooBody = await this.text("/foo");
    expect(fooBody).toContain(
      "var disqus_identifier = 'mixed-case-disqus-id';"
    );

    expect(await areThereComments("/about")).toBe(
      false,
      "comments should not appear on pages"
    );
    expect(await areThereComments("/draft/view/Drafts/test.txt")).toBe(
      false,
      "comments should not appear on drafts"
    );

    // but not on the preview subdomain
    const res = await this.fetch(
      config.protocol +
        "preview-of-my-local-on-" +
        this.blog.handle +
        "." +
        config.host +
        "/foo"
    );
    const body = await res.text();
    expect(body).not.toContain("disqus.com/embed.js");

    // disable comments for the post
    await this.write({
      path: "/a.txt",
      content: "Link: /foo\nComments: No\n\nHello, world!",
    });
    // enable comments for the page
    await this.write({
      path: "/Pages/about.txt",
      content: "Link: /about\nComments: Yes\n\nHello, world!",
    });

    expect(await areThereComments("/about")).toBe(
      true,
      "comments should appear on a pages with comments enabled"
    );

    expect(await areThereComments("/foo")).toBe(
      false,
      "comments should not appear on posts with comments disabled"
    );
  });

  it("normalizes comment metadata toggles", async function () {
    const plugins = {
      ...this.blog.plugins,
      disqus: { enabled: true, options: { shortname: "test" } },
    };
    await this.blog.update({ plugins });

    await this.template({ "entry.html": "{{{entry.html}}} {{> pluginHTML}}" });
    await this.write({
      path: "/post-no.txt",
      content: "Link: /post-no\nComments: no\n\nHello, world!",
    });
    await this.write({
      path: "/post-mixed-no.txt",
      content: "Link: /post-mixed-no\ncOmMeNtS: nO\n\nHello, world!",
    });
    await this.write({
      path: "/Pages/page-mixed-yes.txt",
      content: "Link: /page-mixed-yes\ncOmMeNtS: YeS\n\nHello, page!",
    });
    await this.write({
      path: "/Pages/page-whitespace-yes.txt",
      content: "Link: /page-whitespace-yes\nComments:  yes \n\nHello, page!",
    });

    const areThereComments = async (path) => {
      const body = await this.text(path);
      return (
        body.includes('<div id="disqus_thread"></div>') &&
        body.includes("disqus.com/embed.js")
      );
    };

    expect(await areThereComments("/post-no")).toBe(
      false,
      "comments should not appear on posts with lowercase no"
    );
    expect(await areThereComments("/post-mixed-no")).toBe(
      false,
      "comments should not appear on posts with mixed case no"
    );
    expect(await areThereComments("/page-mixed-yes")).toBe(
      true,
      "comments should appear on pages with mixed case yes"
    );
    expect(await areThereComments("/page-whitespace-yes")).toBe(
      true,
      "comments should appear on pages with whitespace around yes"
    );
  });

  it("injects google analytics into app_js", async function () {
    const plugins = {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: { provider: { Google: true }, trackingID: "UA-12345678-9" },
      },
    };
    await this.blog.update({ plugins });

    await this.template({ "script.js": "{{{app_js}}}" });

    const body = await this.text("/script.js");
    expect(body).toContain("www.google-analytics.com/analytics.js");
    expect(body).toContain(
      `var GAID = '${plugins.analytics.options.trackingID}';`
    );
  });

  it("injects clicky analytics into app_js", async function () {
    const plugins = {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: { provider: { Clicky: true }, trackingID: "123456789" },
      },
    };
    await this.blog.update({ plugins });

    await this.template({ "script.js": "{{{app_js}}}" });

    const body = await this.text("/script.js");
    expect(body).toContain("http://in.getclicky.com");
    expect(body).toContain(
      `clicky.init(${plugins.analytics.options.trackingID})`
    );
  });

  it("injects heap analytics into app_js", async function () {
    const plugins = {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: { provider: { Heap: true }, trackingID: "123456789" },
      },
    };
    await this.blog.update({ plugins });

    await this.template({ "script.js": "{{{app_js}}}" });

    const body = await this.text("/script.js");
    expect(body).toContain("heapanalytics.com");
    expect(body).toContain(
      `heap.load("${plugins.analytics.options.trackingID}")`
    );
  });

  it("injects simple analytics into app_js", async function () {
    const plugins = {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: { provider: { SimpleAnalytics: true } },
      },
    };
    await this.blog.update({ plugins });

    await this.template({ "script.js": "{{{app_js}}}" });

    const body = await this.text("/script.js");
    expect(body).toContain("simpleanalyticscdn.com");
  });

  it("injects plausible analytics into app_js", async function () {
    const plugins = {
      ...this.blog.plugins,
      analytics: { enabled: true, options: { provider: { Plausible: true } } },
    };
    await this.blog.update({ plugins });

    await this.template({ "script.js": "{{{app_js}}}" });

    const body = await this.text("/script.js");
    expect(body).toContain("plausible.io/js/plausible.js");
  });

  it("injects fathom analytics into app_js", async function () {
    const plugins = {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: { provider: { Fathom: true }, trackingID: "123456789" },
      },
    };
    await this.blog.update({ plugins });

    await this.template({ "script.js": "{{{app_js}}}" });

    const body = await this.text("/script.js");
    expect(body).toContain("cdn.usefathom.com");
    expect(body).toContain(
      `fathom('set', 'siteId', '${plugins.analytics.options.trackingID}');`
    );
  });

  it("injects cloudflare analytics into app_js", async function () {
    const plugins = {
      ...this.blog.plugins,
      analytics: {
        enabled: true,
        options: { provider: { Cloudflare: true }, trackingID: "123456789" },
      },
    };
    await this.blog.update({ plugins });

    await this.template({ "script.js": "{{{app_js}}}" });

    const body = await this.text("/script.js");
    expect(body).toContain("cloudflareinsights.com");
    expect(body).toContain(
      `"{'token': '${plugins.analytics.options.trackingID}'}`
    );
  });

  it("injects KaTeX CSS into app_css", async function () {
    const plugins = { ...this.blog.plugins, katex: { enabled: true } };
    await this.blog.update({ plugins });

    await this.template({ "style.css": "{{{app_css}}}" });

    const body = await this.text("/style.css");
    expect(body).toContain(".katex");
  });

  it("injects image zoom CSS and JS into app_css and app_js", async function () {
    const plugins = { ...this.blog.plugins, zoom: { enabled: true } };
    await this.blog.update({ plugins });

    await this.template({
      "style.css": "{{{app_css}}}",
      "script.js": "{{{app_js}}}",
    });

    const bodyCSS = await this.text("/style.css");
    expect(bodyCSS).toContain(".zoom-img");

    const bodyJS = await this.text("/script.js");
    expect(bodyJS).toContain("zoom-overlay");
  });
});
