describe("when redis is unavailable", function () {
  const Blog = require("models/blog");
  const { ClientOfflineError } = require("redis");

  require("./util/setup")();

  it("responds 503 with a generic error page when the blog cannot be looked up", async function () {
    spyOn(Blog, "get").and.callFake(function (identifier, callback) {
      callback(new ClientOfflineError());
    });

    const res = await this.get("/");
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("Temporarily unavailable");
  });

  it("responds 503 when redis fails partway through a request", async function () {
    const Redirects = require("models/redirects");
    spyOn(Redirects, "check").and.callFake(function (blogID, url, callback) {
      callback(new ClientOfflineError());
    });

    const res = await this.get("/no-such-page");

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Temporarily unavailable");
  });

  it("responds 503, not an incomplete cacheable page, when redis fails while retrieving entries", async function () {
    await this.write({ path: "/a.txt", content: "Hello, A!" });
    await this.template({ "entries.html": "{{#entries}}{{{html}}}{{/entries}}" });

    const Entries = require("models/entries");
    spyOn(Entries, "getPage").and.callFake(function () {
      arguments[arguments.length - 1](new ClientOfflineError());
    });

    const res = await this.get("/");

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Temporarily unavailable");
  });

  it("responds 503, not a cacheable 400, when the template cannot be loaded", async function () {
    const Template = require("models/template");
    spyOn(Template, "getMetadata").and.callFake(function (templateID, callback) {
      callback(new ClientOfflineError());
    });

    const res = await this.get("/");

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("responds 503, not an incomplete page, when redis fails while listing all entries", async function () {
    await this.write({ path: "/a.txt", content: "Hello, A!" });
    await this.template({
      "entries.html": "{{#allEntries}}{{{html}}}{{/allEntries}}",
    });

    const Entries = require("models/entries");
    spyOn(Entries, "getAll").and.callFake(function (blogID, options) {
      options.onError(new ClientOfflineError());
    });

    const res = await this.get("/");

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Temporarily unavailable");
  });

  it("responds 503, not an incomplete page, when redis fails while listing recent entries", async function () {
    await this.write({ path: "/a.txt", content: "Hello, A!" });
    await this.template({
      "entries.html": "{{#recentEntries}}{{{html}}}{{/recentEntries}}",
    });

    const Entries = require("models/entries");
    spyOn(Entries, "getRecent").and.callFake(function (blogID, options) {
      options.onError(new ClientOfflineError());
    });

    const res = await this.get("/");

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Temporarily unavailable");
  });

  it("still 404s a missing blog normally", async function () {
    const res = await this.fetch("http://no-such-blog.invalid/");
    expect(res.status).toBe(404);
  });
});
