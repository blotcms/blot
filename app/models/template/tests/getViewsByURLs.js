describe("template", function () {
  const { promisify } = require("util");
  const getViewsByURLs = require("models/template").getViewsByURLs;

  require("./setup")({ createTemplate: true });

  beforeEach(function () {
    this.getViewsByURLs = (urls) =>
      promisify(getViewsByURLs)(this.template.id, urls);
  });

  it("gets views for many URLs at once", async function () {
    await this.setView({ name: "apple.html", url: ["/apple"] });
    await this.setView({ name: "pear.html", url: ["/pear/:variety"] });

    const viewNames = await this.getViewsByURLs([
      "/apple",
      "/pear/conference",
      "/banana",
    ]);

    expect(viewNames).toEqual(["apple.html", "pear.html", null]);
  });

  it("gets views for URLs with a trailing slash, mixed case or query string", async function () {
    await this.setView({ name: "apple.html", url: ["/apple"] });

    expect(await this.getViewsByURLs(["/Apple/", "/apple?foo=bar"])).toEqual([
      "apple.html",
      "apple.html",
    ]);
  });

  it("agrees with getViewByURL", async function () {
    await this.setView({ name: "apple.html", url: ["/apple", "/page/:page"] });

    const urls = ["/apple", "/page/2", "/pear"];
    const viewNames = await this.getViewsByURLs(urls);

    for (const [index, url] of urls.entries()) {
      const { viewName } = await this.getViewByURL(url);
      expect(viewNames[index]).toEqual(viewName || null);
    }
  });

  it("returns nothing when there are no URLs", async function () {
    expect(await this.getViewsByURLs([])).toEqual([]);
  });
});
