const express = require("express");
const paths = require("../paths");

// The params the folder routes gave their handlers under Express 4, when they
// were "/folder/:path(*)", "/folder/remove/:path(*)" and
// "/folder-download/:path(*)": mounted as the dashboard does, under /:handle
describe("dashboard folder routes", function () {
  let server, origin;

  beforeAll(async function () {
    const app = express();
    const site = express.Router();
    const echo = (name) => (req, res) =>
      res.json({ name, path: req.params.path });

    site.get(["/", paths.folder], echo("folder"));
    site.post(paths.remove, echo("remove"));
    site.get("/folder", echo("folder-redirect"));
    site.use(paths.download, echo("download"));
    app.use("/:handle", site);
    app.use((err, req, res, next) => res.status(err.status || 500).end());

    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async function () {
    await new Promise((resolve) => server.close(resolve));
  });

  async function request(method, path) {
    const res = await fetch(origin + path, { method });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {}
    return { status: res.status, body };
  }

  it("gives the folder route the path below /folder/", async function () {
    expect(await request("GET", "/blog/folder/Posts")).toEqual({
      status: 200,
      body: { name: "folder", path: "Posts" },
    });
    expect((await request("GET", "/blog/folder/a/b/c.txt")).body.path).toBe(
      "a/b/c.txt"
    );
  });

  it("decodes spaces and encoded slashes", async function () {
    expect(
      (await request("GET", "/blog/folder/my%20posts/hello%20world.txt")).body
        .path
    ).toBe("my posts/hello world.txt");
    expect((await request("GET", "/blog/folder/a%2Fb")).body.path).toBe("a/b");
    expect(
      (await request("GET", "/blog/folder/%C3%A9t%C3%A9/x.txt")).body.path
    ).toBe("été/x.txt");
  });

  it("keeps a trailing slash and an empty path", async function () {
    expect((await request("GET", "/blog/folder/a/b/")).body.path).toBe("a/b/");
    expect((await request("GET", "/blog/folder/")).body).toEqual({
      name: "folder",
      path: "",
    });
  });

  it("leaves /folder without a slash to its own route", async function () {
    expect((await request("GET", "/blog/folder")).body.name).toBe(
      "folder-redirect"
    );
  });

  it("matches the prefix without regard to case", async function () {
    expect((await request("GET", "/blog/FOLDER/Sub/Dir")).body).toEqual({
      name: "folder",
      path: "Sub/Dir",
    });
  });

  it("answers 400 to a path that does not decode", async function () {
    expect((await request("GET", "/blog/folder/%E0%A4%A")).status).toBe(400);
  });

  it("gives the remove route the path below /folder/remove/", async function () {
    expect(
      (await request("POST", "/blog/folder/remove/my%20posts/hello.txt")).body
    ).toEqual({ name: "remove", path: "my posts/hello.txt" });
    expect((await request("POST", "/blog/folder/remove/a/b/")).body.path).toBe(
      "a/b/"
    );
    expect((await request("POST", "/blog/folder/remove/")).body.path).toBe("");
    expect((await request("GET", "/blog/folder/remove/a")).body.name).toBe(
      "folder"
    );
  });

  it("gives the download route the path below /folder-download/", async function () {
    expect(
      (await request("GET", "/blog/folder-download/a/b%20c/d.txt")).body
    ).toEqual({ name: "download", path: "a/b c/d.txt" });
    expect((await request("GET", "/blog/folder-download/a/b/")).body.path).toBe(
      "a/b/"
    );
    expect((await request("GET", "/blog/folder-download/")).body.path).toBe("");
  });

  it("does not match /folder-download without a slash", async function () {
    expect((await request("GET", "/blog/folder-download")).status).toBe(404);
  });
});
