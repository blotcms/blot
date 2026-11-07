const cheerio = require("cheerio");
const { render } = require("./index.js");
const nock = require("nock");

const validTweetURLs = [
  "https://x.com/Interior/status/463440424141459456",
  "https://twitter.com/Interior/status/463440424141459456",
];

const invalidTweetURLs = [
  "http://twatter.com/davidmerfieId/status/500323409218117633",
  "http://twitter.foo.com/davidmerfieId/status/500323409218117633",
  "https://twitter.com/davidmerfieId/500323409218117633",
  "https://twitter.com/davidmerfieId/status",
  "https://twitter.com/davidmerfieId/ST/500323409218117633",
  "",
  "ABC",
];

const runTest = async (html) => {
  const $ = cheerio.load(html);
  await render($, {});
  return $.html();
};

describe("twitter plugin", function () {
  global.test.timeout(10000); // 10 seconds

  beforeEach(function () {
    nock.disableNetConnect();

    nock("https://publish.twitter.com")
      .persist()
      .get("/oembed")
      .query(true)
      .reply(function (uri) {
        const requestUrl = new URL(
          `https://publish.twitter.com${uri}`
        ).searchParams.get("url");

        // Only mock valid Twitter/X URLs
        if (
          requestUrl &&
          /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/.+\/status\/\d+/.test(
            requestUrl
          )
        ) {
          const html =
            `<blockquote class="twitter-tweet" data-theme="light">` +
            `<p lang="en" dir="ltr">Example tweet content</p>` +
            `&mdash; Example User (@example) <a href="${requestUrl}">Date</a>` +
            `</blockquote>` +
            `<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`;

          return [200, { html }];
        }

        // Return error for invalid URLs
        return [404, { error: "Not found" }];
      });
  });

  afterEach(function () {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("handles valid URLs", async () => {
    for (const url of validTweetURLs) {
      const html = `<p><a href='${url}'>${url}</a></p>`;
      const newHTML = await runTest(html);
      // newHTML should contain a script tag and a blockquote tag
      expect(newHTML).toContain(
        `<script async="" src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`
      );
      expect(newHTML).toContain(`<blockquote class="twitter-tweet"`);
    }
  });

  it("ignores invalid URLs", async () => {
    for (const url of invalidTweetURLs) {
      const html = `<p><a href='${url}'>${url}</a></p>`;
      const newHTML = await runTest(html);
      // newHTML should be the same as the original html
      expect(newHTML).not.toContain(
        `<script async="" src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`
      );
      expect(newHTML).not.toContain(`<blockquote class="twitter-tweet">`);
    }
  });
});
