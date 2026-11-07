describe("bluesky plugin", function () {
  const replaceURLsWithEmbeds = require("./index.js").render;
  const cheerio = require("cheerio");

  global.test.timeout(10000); // 10 seconds

  it("works", async function () {
    // html bare link to a post on bluesky
    const html =
      '<a href="https://bsky.app/profile/emilyliu.me/post/3jzn6g7ixgq2y">https://bsky.app/profile/emilyliu.me/post/3jzn6g7ixgq2y</a>';

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    console.log("html:", $.html());
    expect(
      $("a[href='https://bsky.app/profile/emilyliu.me/post/3jzn6g7ixgq2y']")
        .length
    ).toBe(0);
    expect($("blockquote").length).toBe(1);
  });

  it("does not error when there are no links", async function () {
    const html = "<p>hello</p>";

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    expect($("a").length).toBe(0);
    expect($("blockquote").length).toBe(0);
  });

  // if the bluesky link is invalid or poorly formatted, it should not be replaced
  it("does not error when the link is invalid", async function () {
    const html = '<a href="https://bsky.app">https://bsky.app</a>';

    const $ = cheerio.load(html);

    await replaceURLsWithEmbeds($, {});

    expect($("a").length).toBe(1);
    expect($("blockquote").length).toBe(0);
  });
});
