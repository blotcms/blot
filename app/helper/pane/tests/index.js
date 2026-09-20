const pane = require("../index");
const sample = require("../qa/sample.json");

describe("pane", function () {
  it("renders html, css and js from an indented tree", function () {
    const { html, css, js } = pane.render("Fruits\n  Apple.md\nAbout.txt", { title: "Your site" });
    expect(html).toContain('aria-label="Your site"');
    expect(html.match(/class="pane-row"/g).length).toBe(3);
    expect(html).toContain('style="--d:1"');
    expect(html.match(/pane-folder/g).length).toBe(1);
    expect(css).toContain("html[data-os=win]");
    expect(js.length).toBeLessThan(500);
  });

  it("escapes names", function () {
    expect(pane.render("<b>x</b>").html).not.toContain("<b>x</b>");
  });

  it("returns null for views that are not implemented yet", function () {
    expect(pane.render("a", { view: "icons" })).toBeNull();
    expect(pane.render("a", { view: "list" })).not.toBeNull();
  });

  it("renders every OS's text for size and date columns", function () {
    const { html } = pane.render("About.txt", { files: { "About.txt": sample.files["About.txt"] }, now: sample.now });
    expect(html).toContain('<span data-os="mac">6 bytes</span>');
    expect(html).toContain('<span data-os="linux">Today 15:38</span>');
    expect(html).toContain('<span data-os="mac">3:38 PM</span>');
    expect(html).toContain('<span data-os="win">9/20/2026 3:38 PM</span>');
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
