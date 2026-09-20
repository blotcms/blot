const pane = require("../index");

describe("pane", function () {
  it("renders html, css and js from an indented tree", function () {
    const { html, css, js } = pane.render("Fruits\n  Apple.md\nAbout.txt", { title: "Your site" });
    expect(html).toContain('aria-label="Your site"');
    expect(html.match(/pane-row/g).length).toBe(3);
    expect(html).toContain('style="--d:1"');
    expect(html.match(/pane-folder/g).length).toBe(1);
    expect(css).toContain("html[data-os=win]");
    expect(js.length).toBeLessThan(500);
  });

  it("escapes names", function () {
    expect(pane.render("<b>x</b>").html).not.toContain("<b>x</b>");
  });
});
