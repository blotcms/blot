describe("[folder-asset] log", function () {
  require("./util/setup")();

  const config = require("config");

  // The blog router logs through req.log, which console.logs one string:
  // the request logger puts a date, the request id and +Nms before the
  // arguments. Keep the text after the marker, which is the end of the line.
  // The marker must follow the +Nms: the logger's response line can quote
  // the request's slowest step (slowest=+Nms:"[folder-asset] ...", cut to
  // 80 characters), which is not a second log.
  let lines;
  const pattern = / \+\d+ms \[folder-asset\] (.*)$/;

  beforeEach(function () {
    lines = [];
    const log = console.log;

    spyOn(console, "log").and.callFake(function (...args) {
      const match = pattern.exec(args.join(" "));
      if (match) lines.push(match[1]);
      else return log.apply(console, args);
    });
  });

  const ownHost = (blog) => `${blog.handle}.${config.host}`;

  it("logs a file served from the origin with its referer", async function () {
    await this.write({ path: "/img/a.png", content: "one" });

    const res = await this.get("/img/a.png", {
      headers: { Referer: `https://${ownHost(this.blog)}/posts/hello?x=1` },
    });

    expect(res.status).toBe(200);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(
      [
        `blog=${this.blog.id}`,
        `handle=${this.blog.handle}`,
        "served=origin",
        "path=/img/a.png",
        `referer=${ownHost(this.blog)}/posts/hello`,
        "same_site=1",
      ].join(" ")
    );
  });

  it("percent-encodes a path and referer once", async function () {
    await this.write({ path: "/Luke 15/a.png", content: "one" });
    await this.get("/Luke%2015/a.png", {
      headers: { Referer: `https://${ownHost(this.blog)}/Luke%2015/page.html` },
    });

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("path=/Luke%2015/a.png");
    expect(lines[0]).toContain(`referer=${ownHost(this.blog)}/Luke%2015/page.html`);
  });

  it("logs same_site=0 for a referer on another host", async function () {
    await this.write({ path: "/img/a.png", content: "one" });
    await this.get("/img/a.png", {
      headers: { Referer: "https://example.com/some/page" },
    });

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("referer=example.com/some/page same_site=0");
  });

  it("logs referer=- when there is no Referer", async function () {
    await this.write({ path: "/img/a.png", content: "one" });
    await this.get("/img/a.png");

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("served=origin");
    expect(lines[0]).toContain("referer=- same_site=0");
  });

  it("logs served=cdn-redirect for a large jpg", async function () {
    await this.write({ path: "/big.jpg", content: "x".repeat(300 * 1024) });

    const res = await this.get("/big.jpg", { redirect: "manual" });

    expect(res.status).toBe(302);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("served=cdn-redirect");
    expect(lines[0]).toContain("path=/big.jpg");
  });

  it("logs served=static for a global static file", async function () {
    const res = await this.get("/icons/search.svg", {
      headers: { Referer: `https://${ownHost(this.blog)}/` },
    });

    expect(res.status).toBe(200);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe(
      [
        `blog=${this.blog.id}`,
        `handle=${this.blog.handle}`,
        "served=static",
        "path=/icons/search.svg",
        `referer=${ownHost(this.blog)}/`,
        "same_site=1",
      ].join(" ")
    );
  });

  it("does not log a global static file that is missing", async function () {
    const res = await this.get("/icons/missing.svg");

    expect(res.status).toBe(404);
    expect(lines).toEqual([]);
  });

  it("logs nothing for a page", async function () {
    await this.write({ path: "/page.html", content: "<p>hi</p>" });

    expect(await this.text("/page.html")).toBe("<p>hi</p>");
    expect(lines).toEqual([]);
  });
});
