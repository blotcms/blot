const express = require("express");

// The pages that show the "on this page" navigation are picked by a route with
// a wildcard: /how/format/{*splat} (it was /how/format/* in Express 4)
describe("documentation 'on this page' routes", function () {
  let server, origin, flagged;

  beforeAll(async function () {
    const app = express();

    app.use((req, res, next) => {
      const path = req.path;
      res.on("finish", () => {
        flagged[path] = res.locals["show-on-this-page"] === true;
      });
      next();
    });
    app.use(require("documentation"));

    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(function () {
    flagged = {};
  });

  afterAll(async function () {
    await new Promise((resolve) => server.close(resolve));
  });

  async function isFlagged(path) {
    const res = await fetch(origin + path, { redirect: "manual" });
    await res.text();
    return flagged[path];
  }

  it("flags a page below /how/format/, however deep", async function () {
    expect(await isFlagged("/how/format/markdown")).toBe(true);
    expect(await isFlagged("/how/format/a/b/c")).toBe(true);
    expect(await isFlagged("/how/format/")).toBe(true);
  });

  it("flags the other two paths in the same route", async function () {
    expect(await isFlagged("/how/files/markdown")).toBe(true);
    expect(await isFlagged("/how/formatting/math")).toBe(true);
  });

  it("does not flag a page outside it", async function () {
    expect(await isFlagged("/how/posts")).toBe(false);
  });
});
