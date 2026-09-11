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

describe("zoom plugin", function () {
  it("marks a wide image with a width attribute for zoom", async () => {
    const html = '<img src="a.jpg" width="500">';
    const output = await runTest(html);
    expect(output).toContain('data-action="zoom"');
  });

  it("marks a wide image with a data-width attribute for zoom", async () => {
    const html = '<img src="a.jpg" data-width="500">';
    const output = await runTest(html);
    expect(output).toContain('data-action="zoom"');
  });

  it("does not mark a narrow image for zoom", async () => {
    const html = '<img src="a.jpg" width="200">';
    const output = await runTest(html);
    expect(output).not.toContain("data-action");
  });

  it("does not mark an image exactly at the minimum width", async () => {
    const html = '<img src="a.jpg" width="320">';
    const output = await runTest(html);
    expect(output).not.toContain("data-action");
  });

  it("marks an image one pixel wider than the minimum width", async () => {
    const html = '<img src="a.jpg" width="321">';
    const output = await runTest(html);
    expect(output).toContain('data-action="zoom"');
  });

  it("does not mark an image with no width attribute", async () => {
    const html = '<img src="a.jpg">';
    const output = await runTest(html);
    expect(output).not.toContain("data-action");
  });

  it("does not mark an image with a non-numeric width", async () => {
    const html = '<img src="a.jpg" width="notanumber">';
    const output = await runTest(html);
    expect(output).not.toContain("data-action");
  });

  it("does not mark an image nested inside a link", async () => {
    const html = '<a href="/x"><img src="a.jpg" width="500"></a>';
    const output = await runTest(html);
    expect(output).not.toContain("data-action");
  });

  it("does not mark an image whose src explicitly opts out with zoom=false", async () => {
    const html = '<img src="a.jpg?zoom=false" width="500">';
    const output = await runTest(html);
    expect(output).not.toContain("data-action");
  });

  it("marks an image with an unrelated query string", async () => {
    const html = '<img src="a.jpg?foo=bar" width="500">';
    const output = await runTest(html);
    expect(output).toContain('data-action="zoom"');
  });

  it("does not throw when the image has no src attribute", async () => {
    const html = '<img width="500">';
    const output = await runTest(html);
    expect(output).not.toContain("data-action");
  });

  it("handles multiple images independently", async () => {
    const html =
      '<img src="a.jpg" width="500"><img src="b.jpg" width="100">';
    const output = await runTest(html);
    const $ = cheerio.load(output);
    const images = $("img");
    expect($(images[0]).attr("data-action")).toBe("zoom");
    expect($(images[1]).attr("data-action")).toBeUndefined();
  });
});
