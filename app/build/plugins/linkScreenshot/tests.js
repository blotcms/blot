describe("linkScreenshot plugin", function () {
  const cheerio = require("cheerio");
  const screenshotPath = require.resolve("helper/screenshot");
  const pluginPath = require.resolve("./index.js");

  const opts = { blogID: "blog_test", path: "/bookmark.webloc" };

  // Builds a cheerio doc holding a single bookmark link, the shape the
  // webloc converter produces before this plugin runs.
  const doc = (href) =>
    cheerio.load(`<p><a class="bookmark" href="${href}">Example</a></p>`);

  let calls;
  let optionsSeen;
  let render;

  beforeEach(function () {
    calls = [];
    optionsSeen = [];

    // Stub helper/screenshot in require's cache before (re-)requiring the
    // plugin, so we can assert exactly which URLs this plugin hands to the
    // screenshot service - which is the thing the checks below exist to
    // gate. Without this, a test that only checks "no wrapper was added to
    // the HTML" would pass just as happily against a plugin that rejected
    // every URL, including URLs that should be allowed through.
    delete require.cache[pluginPath];
    delete require.cache[screenshotPath];
    require.cache[screenshotPath] = {
      id: screenshotPath,
      filename: screenshotPath,
      loaded: true,
      exports: Object.assign(
        function (site, path, options) {
          calls.push(site);
          optionsSeen.push(options);
          return Promise.reject(new Error("stub: no real screenshot in tests"));
        },
        { restart: function () {}, shutdown: function () {} }
      ),
    };

    render = require("./index.js").render;
  });

  afterEach(function () {
    delete require.cache[pluginPath];
    delete require.cache[screenshotPath];
  });

  it("hands a plain https URL to the screenshot service", async function () {
    const href = "https://example.com/";

    await render(doc(href), opts);

    expect(calls).toEqual([href]);
  });

  it("marks the screenshot untrusted so it must run in the sandbox", async function () {
    const href = "https://example.com/";

    await render(doc(href), opts);

    expect(optionsSeen.length).toBe(1);
    expect(optionsSeen[0].untrusted).toBe(true);
  });

  // A URL this plugin must refuse to hand to the screenshot service.
  const refused = [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "http://user:secret@example.com/",
    "https://:secret@example.com/",
    "not-a-url",
  ];

  refused.forEach((href) => {
    it("refuses " + href, async function () {
      const $ = doc(href);

      await render($, opts);

      expect(calls).toEqual([]);
      // The link is left untouched - no screenshot wrapper was added.
      expect($.html()).not.toContain("bookmark-container");
      expect($.html()).not.toContain("bookmark-screenshot");
    });
  });

  // Deliberately NOT in `refused`: this plugin only checks protocol and
  // credentials, so a plain http(s) URL pointing at the cloud metadata
  // address is handed to the screenshot service same as any other. It's
  // the browser jail's egress filter (proxy/unit/sandbox/egress.nft) that has
  // to reject this one, not this layer - see app/sandbox/README.md.
  it("passes the metadata address through - it's the sandbox's job to block it", async function () {
    const href = "http://169.254.169.254/latest/meta-data/";

    await render(doc(href), opts);

    expect(calls).toEqual([href]);
  });

  it("does nothing when there is no href", async function () {
    const $ = cheerio.load(`<p><a class="bookmark">Example</a></p>`);

    await render($, opts);

    expect(calls).toEqual([]);
    expect($.html()).not.toContain("bookmark-container");
  });

  it("does nothing for a non-webloc path", async function () {
    const $ = doc("https://example.com/");

    await render($, { blogID: "blog_test", path: "/note.txt" });

    expect(calls).toEqual([]);
    expect($.html()).not.toContain("bookmark-container");
  });
});
