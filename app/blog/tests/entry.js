const getEntry = require("../../models/entry/get");

describe("entry", function () {
  require("./util/setup")();

  it("renders an entry", async function () {
    await this.write({ path: "/a.txt", content: "Link: a\nHello, A!" });

    const body = await this.text("/a", { redirect: "manual" });

    expect(body).toContain("Hello, A!");
  });

  it("if you change an entry's url, the old one will redirect", async function () {
    await this.write({ path: "/a.txt", content: "Link: a\nHello, A!" });
    await this.write({ path: "/a.txt", content: "Link: b\nHello, A!" });

    const res = await this.get("/a", { redirect: "manual" });
    const body = await res.text();

    expect(res.status).toEqual(302);
    expect(body).toContain("Redirecting to /b");

    // it won't redirect if the old URL is the index page (we don't want to clobber the index page)
    await this.write({ path: "/index.txt", content: "Link: /\nHello, A!" });

    expect(await this.text("/", { redirect: "manual" })).toContain("Hello, A!");

    // change the index page
    await this.write({ path: "/index.txt", content: "Link: /c\nHello, A!" });

    const res3 = await this.get("/", { redirect: "manual" });
    expect(res3.status).not.toEqual(302);
  });

  it("will not render a scheduled entry unless the query string scheduled is set to true", async function () {
    // 1 year from now
    const date = new Date();
    date.setFullYear(date.getFullYear() + 1);
    const dateString = date.toISOString();

    await this.write({
      path: "/a.txt",
      content: "Link: a\nDate: " + dateString + "\n\nHello, A!",
    });

    const res = await this.get("/a");

    expect(res.status).toEqual(404);

    const body = await this.text("/a?scheduled=true");

    expect(body).toContain("Hello, A!");
  });

  it("redirects to the source file for a post with ?source=true", async function () {
    await this.write({ path: "/a.txt", content: "Link: a\nHello, A!" });

    const res = await this.get("/a?source=true", { redirect: "manual" });
    const body = await res.text();

    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).toEqual("/a.txt");
    expect(body).toContain("Redirecting to /a.txt");
  });

  it("renders the entry against other urls", async function () {
    await this.write({ path: "/a.txt", content: "Link: a\nHello, A!" });

    const urls = [
      "/A", // case insensitive
      "/a/", // trailing slash
      "/A/", // case insensitive with trailing slash
    ];

    for (const url of urls) {
      const body = await this.text(url, { redirect: "manual" });

      expect(body).toContain("Hello, A!");
    }
  });

  it("renders canonical unicode URLs without redirect", async function () {
    await this.write({
      path: "/grüße.txt",
      content: "Link: /grüße\nHello, Grüße!",
    });

    const body = await this.text("/grüße", { redirect: "manual" });

    expect(body).toContain("Hello, Grüße!");
  });

  it("does not crash when the URL contains malformed percent-encoding", async function () {
    await this.write({ path: "/malformed.txt", content: "Hello!" });

    let error;
    let res;

    try {
      res = await this.get("/%E0%A4%A", { redirect: "manual" });
    } catch (err) {
      error = err;
    }

    if (error) throw error;

    expect(res.status).toEqual(400);
  });

  it("resolves a permalink with a literal percent-encoded token after one decode", async function () {
    await this.write({
      path: "/encoded.txt",
      content: "Link: /a%2520b\nHello, encoded!",
    });

    const body = await this.text("/a%2520b", { redirect: "manual" });

    expect(body).toContain("Hello, encoded!");
  });

  it("adds dependency when URL is deduplicated during rename", async function () {
    await this.write({ path: "/a.txt", content: "Link: a\nHello, A!" });
    await this.write({ path: "/a1.txt", content: "Link: a\nHello, A1!" });

    const getEntryByPath = (path) =>
      new Promise((resolve) => {
        getEntry(this.blog.id, path, (entry) => resolve(entry));
      });

    const secondEntry = await getEntryByPath("/a1.txt");

    expect(secondEntry.url).toEqual("/a-2");
    expect(secondEntry.dependencies).toContain("/a.txt");

    await this.remove("/a.txt");
    await this.write({ path: "/a1.txt", content: "Link: a\nHello, A1!" });

    const updatedEntry = await getEntryByPath("/a1.txt");

    expect(updatedEntry.url).toEqual("/a");
    expect(updatedEntry.dependencies).not.toContain("/a.txt");
  });
});
