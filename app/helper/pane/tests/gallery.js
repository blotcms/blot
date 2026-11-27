// The gallery server (app/helper/pane/gallery): serves the page for each OS from the live pane code.
// No Chrome needed.
const http = require("http");
const fs = require("fs");
const path = require("path");
const keepAnchor = require("../gallery/public/anchor");
const { createServer } = require("../gallery/server");

describe("pane gallery", function () {
  let app;
  let server;
  let base;

  beforeAll(async () => {
    app = createServer();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    app.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const get = async (path) => {
    const res = await fetch(base + path);
    return {
      status: res.status,
      type: res.headers.get("content-type"),
      body: await res.text(),
    };
  };

  ["mac", "win", "linux"].forEach((os) => {
    it(`serves the page for ?os=${os} with the tab selected`, async function () {
      const { status, body } = await get(`/?os=${os}`);
      expect(status).toBe(200);
      expect(body).toContain('class="pane');
      expect(body).toContain(`<html lang="en" data-os="${os}"`);
      expect(body).toContain(`data-os="${os}" aria-selected="true"`);
      expect(body.match(/aria-selected="true"/g).length).toBe(1);
    });
  });

  it("pins each window to both themes by default and honours ?theme", async function () {
    const both = await get("/");
    expect(both.body).toContain('data-theme="light"');
    expect(both.body).toContain('data-theme="dark"');
    expect(both.body).toContain('data-mode="both"');
    expect((await get("/?theme=dark")).body).toContain('data-mode="dark"');
  });

  it("falls back to macOS and Both for unknown values", async function () {
    const { body } = await get("/?os=beos&theme=sepia");
    expect(body).toContain('data-os="mac" data-mode="both"');
  });

  it("has every section, and says so when a window is not built yet", async function () {
    const { body } = await get("/");
    ["finder", "browser", "desktop", "logos", "editors"].forEach((id) =>
      expect(body).toContain(`<section id="${id}"`)
    );
    if (typeof require("../index").browser !== "function")
      expect(body).toContain("pane.browser is not built on this branch yet");
  });

  it("has a browser window per OS, at its capture's size, next to that OS's -browser reference", async function () {
    const { body } = await get("/");
    ["mac", "win", "linux"].forEach((os) => {
      expect(body).toContain(`class="only" data-only="${os}"`);
      expect(body).toContain(`data-pin="${os}"`);
    });
    expect(body).toContain("--pane-w:720px"); // GNOME Web's capture
    ["macos", "windows", "linux"].forEach((dir) =>
      ["light", "dark"].forEach((theme) => {
        const file = `${dir}-${theme}@2x-browser.png`;
        expect(
          fs.existsSync(path.join(__dirname, "..", "reference", dir, file))
        ).toBe(true);
        expect(body).toContain(`/reference/${dir}/${file}`);
      })
    );
  });

  describe("section anchors", function () {
    const stage = (hash, known = true) => {
      const listeners = {};
      const scrolls = [];
      const win = {
        location: { hash },
        addEventListener: (type, fn) => (listeners[type] = fn),
      };
      const doc = {
        getElementById: (id) =>
          known && id === "logos"
            ? { scrollIntoView: (o) => scrolls.push(o) }
            : null,
      };
      return { win, doc, listeners, scrolls };
    };

    it("scrolls to the fragment's section each time it is asked, instantly", function () {
      const s = stage("#logos");
      const anchor = keepAnchor(s.win, s.doc);
      expect(anchor.go()).toBe(true);
      expect(anchor.go()).toBe(true);
      expect(s.scrolls).toEqual([
        { behavior: "instant", block: "start" },
        { behavior: "instant", block: "start" },
      ]);
    });

    it("does nothing without a fragment or for an unknown one", function () {
      expect(keepAnchor(stage("").win, stage("").doc).go()).toBe(false);
      const s = stage("#nope%E0%A4%A", false);
      expect(keepAnchor(s.win, s.doc).go()).toBe(false);
    });

    it("lets go once the reader scrolls, and follows again for a new fragment", function () {
      const s = stage("#logos");
      const anchor = keepAnchor(s.win, s.doc);
      s.listeners.wheel();
      expect(anchor.go()).toBe(false);
      expect(s.scrolls.length).toBe(0);
      s.listeners.hashchange();
      expect(anchor.go()).toBe(true);
    });

    it("is loaded by the page before the gallery script", async function () {
      const { body } = await get("/");
      expect(body.indexOf("/_gallery/anchor.js")).toBeGreaterThan(0);
      expect(body.indexOf("/_gallery/anchor.js")).toBeLessThan(
        body.indexOf("/_gallery/gallery.js")
      );
      expect((await get("/_gallery/anchor.js")).status).toBe(200);
    });
  });

  it("serves its assets, fixtures and references", async function () {
    expect((await get("/_gallery/gallery.js")).status).toBe(200);
    expect((await get("/_gallery/gallery.css")).type).toContain("css");
    expect((await get("/fixtures/cv/")).body).toContain("Clara Xiao");
    expect((await get("/reference/macos/macos-light@2x.png")).status).toBe(200);
    expect((await get("/reference/../index.js")).status).not.toBe(200);
  });
});
