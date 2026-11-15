describe("template", function () {
  const getViewsByURLs = require("models/template").getViewsByURLs;

  const client = require("models/client");
  const key = require("../key");

  require("./setup")({ createTemplate: true });

  beforeEach(function () {
    this.getViewsByURLs = (urls) => getViewsByURLs(this.template.id, urls);
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

  it("routes most explicit first, like getViewByURL", async function () {
    await this.setView({ name: "entry.html", url: ["/:slug"] });
    await this.setView({ name: "style.css", url: ["/style.css"] });
    await this.setView({ name: "catchall.html", url: ["/{*path}"] });
    await client.set(key.url(this.template.id, "/old"), "old.html");
    // The view has patterns, so its exact-URL key is ignored
    await client.set(key.url(this.template.id, "/other"), "style.css");

    const urls = ["/style.css", "/hello", "/a/b", "/old", "/other", "/"];
    const viewNames = await this.getViewsByURLs(urls);

    expect(viewNames).toEqual([
      "style.css",
      "entry.html",
      "catchall.html",
      "old.html",
      "entry.html",
      "catchall.html",
    ]);

    for (const [index, url] of urls.entries()) {
      const { viewName } = await this.getViewByURL(url);
      expect(viewNames[index]).toEqual(viewName);
    }
  });

  it("returns nothing when there are no URLs", async function () {
    expect(await this.getViewsByURLs([])).toEqual([]);
  });
});
