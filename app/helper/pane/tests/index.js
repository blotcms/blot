const pane = require("../index");
const sample = require("../qa/sample.json");

describe("pane", function () {
  it("renders a window from an indented tree, with assets kept apart", function () {
    const result = pane.folder("Fruits\n  Apple.md\nAbout.txt", { title: "Your site" });
    expect(Object.keys(result)).toEqual(["html"]);
    expect(result.html).toContain('aria-label="Your site"');
    expect(result.html.match(/class="pane-row/g).length).toBe(3);
    expect(result.html.match(/pane-k-folder/g).length).toBe(1);
    const { css, js } = pane.assets();
    expect(css).toContain("html[data-os=mac]");
    expect(js.length).toBeLessThan(500);
  });

  it("returns the same assets every time (static, cacheable)", function () {
    expect(pane.assets()).toEqual(pane.assets());
  });

  it("escapes names and titles", function () {
    expect(pane.folder("<b>x</b>").html).not.toContain("<b>x</b>");
    expect(pane.folder("a", { title: '"><script>' }).html).not.toContain("<script>");
  });

  describe("options", function () {
    it("returns null for views that are not implemented yet", function () {
      expect(pane.folder("a.md", { view: "icons" })).not.toBeNull();
      expect(pane.folder("a.md", { view: "list" })).not.toBeNull();
      expect(pane.folder("a.md", { view: "columns" })).toBeNull();
    });
    it("returns null for the editor windows, which are not built yet", function () {
      expect(pane.text("hello")).toBeNull();
      expect(pane.code("<p>", { lang: "html" })).toBeNull();
    });
    it("can pin a window to an OS and a theme", function () {
      const html = pane.folder("About.txt", { os: "mac", theme: "dark", files: { "About.txt": { bytes: 6, modified: "2026-09-20T15:38:00" } }, now: "2026-09-20T15:38:00" }).html;
      expect(html).toContain('data-pin="mac"');
      expect(html).toContain('data-theme="dark"');
      // only the pinned OS's text is emitted (a pin needs a built skin: see tests/os.js)
      expect(html).toContain('<span data-os="mac">');
      expect(html).not.toContain('<span data-os="win">');
    });
    it("ignores an unknown OS or theme", function () {
      const html = pane.folder("a.md", { os: "beos", theme: "sepia" }).html;
      expect(html).not.toContain("data-pin");
      expect(html).not.toContain("data-theme");
    });
    it("sets the size as CSS variables", function () {
      expect(pane.folder("a.md", { width: "400px", height: "auto" }).html).toContain('style="--pane-w:400px;--pane-h:auto"');
    });
    it("never depends on the clock: the same input gives the same output", function () {
      const opts = { files: { "a.md": { bytes: 6, modified: "2026-09-20T15:38:00" } } };
      expect(pane.folder("a.md", opts).html).toEqual(pane.folder("a.md", opts).html);
    });
  });

  it("renders every OS's text for size and date columns", function () {
    const { html } = pane.folder("About.txt", { files: { "About.txt": sample.files["About.txt"] }, now: sample.now });
    expect(html).toContain('<span data-os="mac">6 bytes</span>');
    expect(html).toContain('<span data-os="linux">Today 15:38</span>');
    expect(html).toContain('<span data-os="mac">3:38 PM</span>');
    expect(html).toContain('<span data-os="win">9/20/2026 3:38 PM</span>');
  });

  describe("transform", function () {
    const cheerio = require("cheerio");
    it("replaces pre.folder blocks and leaves unsupported ones alone", function () {
      const $ = cheerio.load('<pre class="folder" title="Your site"><code>Pages\n  About.txt\nPosts/</code></pre><pre class="code"><code>x</code></pre>', { decodeEntities: false }, false);
      pane.transform($);
      expect($("figure.pane").length).toBe(1);
      expect($("figure.pane").attr("aria-label")).toBe("Your site");
      expect($("figure.pane .pane-row").length).toBe(3);
      expect($("pre.code").length).toBe(1);
    });
  });

  describe("formatSize", function () {
    it("follows each OS's conventions", function () {
      expect(pane.formatSize(6, "mac")).toBe("6 bytes");
      expect(pane.formatSize(1, "linux")).toBe("1 byte");
      expect(pane.formatSize(2734, "mac")).toBe("3 KB");
      expect(pane.formatSize(3947, "mac")).toBe("4 KB");
      expect(pane.formatSize(1786, "mac")).toBe("2 KB");
      expect(pane.formatSize(2734, "linux")).toBe("2.7 kB");
      expect(pane.formatSize(2734, "win")).toBe("3 KB");
      expect(pane.formatSize(1500000, "linux")).toBe("1.5 MB");
    });
    it("formats folder sizes", function () {
      expect(pane.formatFolderSize(1, "mac")).toBe("--");
      expect(pane.formatFolderSize(1, "linux")).toBe("1 item");
      expect(pane.formatFolderSize(3, "linux")).toBe("3 items");
      expect(pane.formatFolderSize(3, "win")).toBe("");
    });
  });

  describe("formatDate", function () {
    const now = "2026-09-20T15:38:00";
    it("shows today as a time on macOS and GNOME Files, absolute dates on Windows", function () {
      expect(pane.formatDate("2026-09-20T15:38:00", "mac", now)).toBe("3:38 PM");
      expect(pane.formatDate("2026-09-20T00:00:00", "mac", now)).toBe("12:00 AM");
      expect(pane.formatDate("2026-09-20T00:00:00", "linux", now)).toBe("Today 0:00");
      expect(pane.formatDate("2026-09-20T15:38:00", "win", now)).toBe("9/20/2026 3:38 PM");
    });
    it("shows older dates in each OS's format", function () {
      expect(pane.formatDate("2026-08-14T15:25:00", "mac", now)).toBe("8/14/26");
      expect(pane.formatDate("2026-08-14T15:25:00", "linux", now)).toBe("14 Aug 2026");
      expect(pane.formatDate("2026-08-14T15:25:00", "win", now)).toBe("8/14/2026 3:25 PM");
    });
  });
});
