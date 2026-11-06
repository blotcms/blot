describe("bluesky plugin", function () {
  const replaceURLsWithEmbeds = require("./index.js").render;
  const cheerio = require("cheerio");

  global.test.timeout(10000); // 10 seconds

  it("works", function (done) {
    // html bare link to a post on bluesky
    const html =
      '<a href="https://bsky.app/profile/emilyliu.me/post/3jzn6g7ixgq2y">https://bsky.app/profile/emilyliu.me/post/3jzn6g7ixgq2y</a>';

    const $ = cheerio.load(html);

    replaceURLsWithEmbeds($, function () {
      console.log("html:", $.html());
      expect(
        $("a[href='https://bsky.app/profile/emilyliu.me/post/3jzn6g7ixgq2y']")
          .length
      ).toBe(0);
      expect($("blockquote").length).toBe(1);
      done();
    });
  });

  it("does not error when there are no links", function (done) {
    const html = "<p>hello</p>";

    const $ = cheerio.load(html);

    replaceURLsWithEmbeds($, function () {
      expect($("a").length).toBe(0);
      expect($("blockquote").length).toBe(0);
      done();
    });
  });

  // if the bluesky link is invalid or poorly formatted, it should not be replaced
  it("does not error when the link is invalid", function (done) {
    const html = '<a href="https://bsky.app">https://bsky.app</a>';

    const $ = cheerio.load(html);

    replaceURLsWithEmbeds($, function () {
      expect($("a").length).toBe(1);
      expect($("blockquote").length).toBe(0);
      done();
    });
  });
});
