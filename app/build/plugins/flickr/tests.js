describe("flickr plugin", function () {
  const replaceURLsWithEmbeds = require("./index.js").render;
  const cheerio = require("cheerio");
  const nock = require("nock");

  global.test.timeout(10000); // 10 seconds

  beforeEach(function () {
    nock.disableNetConnect();

    nock("https://www.flickr.com")
      .persist()
      .get("/services/oembed/")
      .query(true)
      .reply(function (uri) {
        const requestUrl = new URL(
          `https://www.flickr.com${uri}`
        ).searchParams.get("url");

        const anchorHref =
          requestUrl && requestUrl.startsWith("https://www.flickr.com/")
            ? requestUrl
            : "https://www.flickr.com/photos/example/12345/";

        const html =
          `<a data-flickr-embed='true' href='${anchorHref}'>` +
          "<img src='https://live.staticflickr.com/65535/example.jpg' alt='Example photo'/>" +
          "</a>" +
          "<script async src='https://embedr.flickr.com/assets/client-code.js' charset='utf-8'></script>";

        return [200, { html }];
      });
  });

  afterEach(function () {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("works for short flickr URLs", async function () {
    // html bare link to a post on bluesky
    const html =
      '<a href="https://flic.kr/p/2quEvYr">https://flic.kr/p/2quEvYr</a>';

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    expect($("a[href='https://flic.kr/p/2quEvYr']").length).toBe(0);
    expect($("a[data-flickr-embed='true']").length).toBe(1);
    expect($("img").length).toBe(1);
    expect($("script").length).toBe(1);
  });

  it("works with multiple Flickr links in the input", async function () {
    const html = `
      <a href="https://flic.kr/p/2quEvYr">https://flic.kr/p/2quEvYr</a>
      <a href="https://www.flickr.com/photos/jemostrom/54145631949/">https://www.flickr.com/photos/jemostrom/54145631949/</a>
    `;

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    expect($("a[data-flickr-embed='true']").length).toBe(2);
    expect($("img").length).toBe(2);
    expect($("script").length).toBe(2);
  });

  it("handles a mix of valid and invalid links", async function () {
    const html = `
      <a href="https://flic.kr/p/2quEvYr">https://flic.kr/p/2quEvYr</a>
      <a href="https://example.com">https://example.com</a>
    `;

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    expect($("a[href='https://example.com']").length).toBe(1);
    expect($("a[data-flickr-embed='true']").length).toBe(1);
    expect($("img").length).toBe(1);
    expect($("script").length).toBe(1);
  });

  it("works for full flickr URLs", async function () {
    const html =
      '<a href="https://www.flickr.com/photos/jemostrom/54145631949/">https://www.flickr.com/photos/jemostrom/54145631949/<a>';

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    expect(
      $("a[href='https://www.flickr.com/photos/jemostrom/54145631949/']").length
    ).toBe(1);
    expect($("a[data-flickr-embed='true']").length).toBe(1);
    expect($("img").length).toBe(1);
    expect($("script").length).toBe(1);
  });

  it("does not error when there are no links", async function () {
    const html = "<p>hello</p>";

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    expect($("a").length).toBe(0);
    expect($("blockquote").length).toBe(0);
  });

  it("skips links where href does not match text", async function () {
    const html = '<a href="https://flic.kr/p/2quEvYr">Some other text</a>';

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    expect($("a[href='https://flic.kr/p/2quEvYr']").length).toBe(1);
    expect($("a[data-flickr-embed='true']").length).toBe(0);
    expect($("img").length).toBe(0);
    expect($("script").length).toBe(0);
  });

  // if the flickr link is invalid or poorly formatted, it should not be replaced
  it("does not error when the flickr link is invalid", async function () {
    const html = '<a href="https://bsky.app">https://bsky.app</a>';

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    expect($("a").length).toBe(1);
    expect($("a[href='https://bsky.app']").text()).toBe("https://bsky.app");
    expect($(".flickr-embed").length).toBe(0);
    expect($("img").length).toBe(0);
    expect($("script").length).toBe(0);
  });
});
