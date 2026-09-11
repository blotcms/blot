const cheerio = require("cheerio");
const { render } = require("./index.js");

const runTest = (html, options) => {
  return new Promise((resolve, reject) => {
    const $ = cheerio.load(html);
    render(
      $,
      function (err) {
        if (err) return reject(err);
        resolve($.html());
      },
      options
    );
  });
};

const options = {
  domain: "example.com",
  baseURL: "https://example.com",
};

describe("externalLinks plugin", function () {
  it("adds target=_blank to links pointing to other hosts", async () => {
    const html = '<a href="https://other.com/page">link</a>';
    const output = await runTest(html, options);
    expect(output).toContain('target="_blank"');
  });

  it("does not touch links to the site's own domain", async () => {
    const html = '<a href="https://example.com/page">link</a>';
    const output = await runTest(html, options);
    expect(output).not.toContain("target=");
  });

  it("does not touch links to the site's baseURL host", async () => {
    const html = '<a href="https://example.com/other">link</a>';
    const output = await runTest(html, options);
    expect(output).not.toContain("target=");
  });

  it("does not touch links to the raw options.domain value", async () => {
    const html = '<a href="https://example.com/">link</a>';
    const output = await runTest(html, options);
    expect(output).not.toContain("target=");
  });

  it("does not touch relative links, which have no host", async () => {
    const html = '<a href="/about">link</a>';
    const output = await runTest(html, options);
    expect(output).not.toContain("target=");
  });

  it("does not touch links with no href attribute", async () => {
    const html = "<a>link</a>";
    const output = await runTest(html, options);
    expect(output).not.toContain("target=");
  });

  it("ignores unparseable href values instead of throwing", async () => {
    const html = '<a href="http://[invalid">link</a>';
    const output = await runTest(html, options);
    expect(output).not.toContain("target=");
  });

  it("handles multiple links independently", async () => {
    const html =
      '<a href="https://other.com/a">a</a><a href="https://example.com/b">b</a><a href="https://another.com/c">c</a>';
    const output = await runTest(html, options);
    const $ = cheerio.load(output);
    const links = $("a");
    expect($(links[0]).attr("target")).toBe("_blank");
    expect($(links[1]).attr("target")).toBeUndefined();
    expect($(links[2]).attr("target")).toBe("_blank");
  });

  it("skips processing without throwing when options can't be parsed", async () => {
    const html = '<a href="https://other.com/page">link</a>';
    const output = await runTest(html, { domain: null, baseURL: null });
    expect(output).not.toContain("target=");
  });
});
