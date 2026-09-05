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
  let render;

  beforeEach(function () {
    calls = [];

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
        function (site) {
          calls.push(site);
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

  it("hands a plain https URL to the screenshot service", function (done) {
    const href = "https://example.com/";

    render(doc(href), function () {
      expect(calls).toEqual([href]);
      done();
    }, opts);
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
    it("refuses " + href, function (done) {
      const $ = doc(href);

      render($, function () {
        expect(calls).toEqual([]);
        // The link is left untouched - no screenshot wrapper was added.
        expect($.html()).not.toContain("bookmark-container");
        expect($.html()).not.toContain("bookmark-screenshot");
        done();
      }, opts);
    });
  });

  // Deliberately NOT in `refused`: this plugin only checks protocol and
  // credentials, so a plain http(s) URL pointing at the cloud metadata
  // address is handed to the screenshot service same as any other. It's
  // the airlock's egress filter (config/airlock/egress.nft) that has to
  // reject this one, not this layer - see config/airlock/README.md.
  it("passes the metadata address through - it's the airlock's job to block it", function (done) {
    const href = "http://169.254.169.254/latest/meta-data/";

    render(doc(href), function () {
      expect(calls).toEqual([href]);
      done();
    }, opts);
  });

  it("does nothing when there is no href", function (done) {
    const $ = cheerio.load(`<p><a class="bookmark">Example</a></p>`);

    render($, function () {
      expect(calls).toEqual([]);
      expect($.html()).not.toContain("bookmark-container");
      done();
    }, opts);
  });

  it("does nothing for a non-webloc path", function (done) {
    const $ = doc("https://example.com/");

    render($, function () {
      expect(calls).toEqual([]);
      expect($.html()).not.toContain("bookmark-container");
      done();
    }, { blogID: "blog_test", path: "/note.txt" });
  });
});
