const express = require("express");
const drafts = require("sync/update/drafts");

// /draft/view/{*splat} and /draft/stream/{*splat} replaced /draft/view/* and
// /draft/stream/*. The handlers read the file path from the URL, not from a
// param, so what matters is which URLs reach them and what getPath makes of
// them.
describe("draft routes", function () {
  let server, origin;

  beforeAll(async function () {
    const app = express();

    for (const route of [drafts.viewRoute, drafts.streamRoute]) {
      app.get(route, (req, res) =>
        res.json({ filePath: drafts.getPath(req.url, route) })
      );
    }

    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async function () {
    await new Promise((resolve) => server.close(resolve));
  });

  async function request(path) {
    const res = await fetch(origin + path);
    return {
      status: res.status,
      body: res.status === 200 ? await res.json() : null,
    };
  }

  it("reads a nested path from the view URL", async function () {
    expect(await request("/draft/view/Drafts/a/b.txt")).toEqual({
      status: 200,
      body: { filePath: "/Drafts/a/b.txt" },
    });
  });

  it("decodes spaces and keeps a trailing slash", async function () {
    expect(
      (await request("/draft/view/My%20Drafts/hello%20world.txt")).body
    ).toEqual({ filePath: "/My Drafts/hello world.txt" });
    expect((await request("/draft/view/Drafts/dir/")).body).toEqual({
      filePath: "/Drafts/dir/",
    });
  });

  it("reads the path from the stream URL", async function () {
    expect((await request("/draft/stream/Drafts/a%20b.txt")).body).toEqual({
      filePath: "/Drafts/a b.txt",
    });
  });

  it("matches the routes as they were matched", async function () {
    // The wildcard could be empty: the URL below is the route's own prefix
    expect((await request("/draft/view/")).status).toBe(200);
    expect((await request("/draft/stream/")).status).toBe(200);
    // ... but the prefix needs its slash
    expect((await request("/draft/view")).status).toBe(404);
    expect((await request("/draft/stream")).status).toBe(404);
  });

  it("builds the preview URL and stream URL from the routes", function () {
    expect(drafts.viewRoute).toBe("/draft/view/{*splat}");
    expect(drafts.streamRoute).toBe("/draft/stream/{*splat}");
    expect(drafts.getPath("/draft/view/Drafts/a.txt", drafts.viewRoute)).toBe(
      "/Drafts/a.txt"
    );
  });
});
