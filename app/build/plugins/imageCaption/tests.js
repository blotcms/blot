const cheerio = require("cheerio");
const { render } = require("./index.js");

const runTest = (html) => {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(html);
    render($, function (err) {
      if (err) return reject(err);
      resolve($.html());
    });
  });
};

describe("imageCaption plugin", function () {
  it("adds a caption from the title attribute", async () => {
    const html = '<img src="a.jpg" title="A title">';
    const output = await runTest(html);
    expect(output).toContain('<span class="caption">A title</span>');
  });

  it("adds a caption from the alt attribute when there is no title", async () => {
    const html = '<img src="a.jpg" alt="Alt text">';
    const output = await runTest(html);
    expect(output).toContain('<span class="caption">Alt text</span>');
  });

  it("prefers the title attribute over the alt attribute", async () => {
    const html = '<img src="a.jpg" title="Title" alt="Alt">';
    const output = await runTest(html);
    expect(output).toContain('<span class="caption">Title</span>');
    expect(output).not.toContain('<span class="caption">Alt</span>');
  });

  it("does nothing when there is no title or alt attribute", async () => {
    const html = '<img src="a.jpg">';
    const output = await runTest(html);
    expect(output).not.toContain("caption");
  });

  it("ignores emoji images even if they have alt text", async () => {
    const html = '<img class="emoji" src="a.png" alt=":smile:">';
    const output = await runTest(html);
    expect(output).not.toContain("caption");
  });

  it("wraps the parent .image element rather than the img itself", async () => {
    const html = '<div class="image"><img src="a.jpg" alt="Alt text"></div>';
    const output = await runTest(html);
    expect(output).toContain(
      '<div class="image"><img src="a.jpg" alt="Alt text"></div><span class="caption">Alt text</span>'
    );
  });

  it("inserts the caption directly after the img when there's no .image parent", async () => {
    const html = '<p><img src="a.jpg" alt="Alt text"></p>';
    const output = await runTest(html);
    expect(output).toContain(
      '<img src="a.jpg" alt="Alt text"><span class="caption">Alt text</span>'
    );
  });

  it("does not caption an image inside a paragraph with other text", async () => {
    const html = '<p>Some text <img src="a.jpg" alt="Alt text"></p>';
    const output = await runTest(html);
    expect(output).not.toContain("caption");
  });

  it("does caption an image whose siblings are only whitespace text", async () => {
    const html = '<p>\n  <img src="a.jpg" alt="Alt text">\n</p>';
    const output = await runTest(html);
    expect(output).toContain('<span class="caption">Alt text</span>');
  });

  it("allows sibling elements with the caption class", async () => {
    const html =
      '<p><img src="a.jpg" alt="Alt text"><span class="caption">Existing</span></p>';
    const output = await runTest(html);
    expect(output).toContain('<span class="caption">Alt text</span>');
  });

  it("allows sibling img elements without blocking the caption", async () => {
    const html =
      '<p><img src="a.jpg" alt="First"><img src="b.jpg" alt="Second"></p>';
    const output = await runTest(html);
    expect(output).toContain('<span class="caption">First</span>');
    expect(output).toContain('<span class="caption">Second</span>');
  });

  it("escapes HTML-sensitive characters found in the alt text", async () => {
    const html = '<img src="a.jpg" alt="Tom & Jerry">';
    const output = await runTest(html);
    expect(output).toContain('<span class="caption">Tom &amp; Jerry</span>');
  });

  it("handles multiple images in the document independently", async () => {
    const html =
      '<img src="a.jpg" title="First"><img src="b.jpg" title="Second">';
    const output = await runTest(html);
    expect(output).toContain('<span class="caption">First</span>');
    expect(output).toContain('<span class="caption">Second</span>');
  });
});
