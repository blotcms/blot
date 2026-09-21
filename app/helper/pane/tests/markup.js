const pane = require("../index");

describe("pane markup", function () {
  const html = pane.folder("Fruits\n  Apple.md\nAbout.txt", { title: "Your site" }).html;

  it("is a figure with aria-hidden chrome and a nested list", function () {
    expect(html).toMatch(/^<figure class="pane[ "]/);
    expect(html).toContain('<div class="pane-bar" aria-hidden="true">Your site</div>');
    expect(html).toContain('<div class="pane-head" aria-hidden="true">');
    expect(html).toContain('<li><span class="pane-row pane-open">');
    expect(html.match(/<ul/g).length).toBe(2);
    expect(html.match(/<ul[^>]*role="list"/g).length).toBe(2);
    expect(html).not.toContain("role=\"tree\"");
    expect(html).toContain(", folder, expanded");
  });

  it("stripes every second visible row with a class, nested rows included", function () {
    const rows = html.match(/class="pane-row[^"]*"/g);
    expect(rows.map((r) => r.includes("pane-odd"))).toEqual([false, true, false]);
  });

  it("makes the list a keyboard-reachable scroller only when it can scroll", function () {
    // a window for macOS or Linux only: nothing to scroll with a few rows
    const few = "Fruits\n  Apple.md\nAbout.txt";
    expect(pane.folder(few, { os: "mac" }).html).not.toContain("tabindex");
    expect(pane.folder(few, { os: "linux" }).html).not.toContain("tabindex");
    // the Windows list is always wider than its window, so any window Windows can apply to scrolls
    expect(pane.folder(few, { os: "win" }).html).toContain('tabindex="0"');
    expect(html).toContain('tabindex="0"');
    const many = Array.from({ length: 14 }, (_, i) => `f${i}.md`).join("\n");
    expect(pane.folder(many, { title: "Site" }).html).toContain('tabindex="0" aria-label="Site"');
    expect(pane.folder("a.md", { height: "200px" }).html).toContain('tabindex="0"');
  });

  it("accepts the tree view as the list view, and returns null for views not built", function () {
    expect(pane.folder("a.md", { view: "tree" })).not.toBeNull();
    expect(pane.folder("a.md", { view: "gallery" })).toBeNull();
  });

  it("gives every icon a kind and never uses bitmap chrome", function () {
    const h = pane.folder("a.txt\nb.png\nc.md\nd.html\ne.doc\nf.xyz\ng.webloc\nDir").html;
    for (const k of ["text", "image", "md", "html", "doc", "generic", "link", "folder"]) expect(h).toContain(`pane-k-${k}`);
    expect(html).not.toMatch(/<img|\.png/);
  });

  it("emits one child per OS for cells, or only the pinned OS's", function () {
    const files = { "a.md": { bytes: 6, modified: "2026-09-20T15:38:00" } };
    const all = pane.folder("a.md", { files, now: "2026-09-20T15:38:00" }).html;
    expect(all.match(/data-os="(mac|win|linux)"/g).length).toBe(7); // date and size for each OS, and Type for win
    const pinned = pane.folder("a.md", { files, now: "2026-09-20T15:38:00", os: "mac" }).html;
    expect(pinned.match(/data-os="/g).length).toBe(2); // no Type cell: macOS hides Kind
    expect(pinned).toContain("3:38 PM");
  });

  it("uses columns written after a pipe as they are", function () {
    const h = pane.folder("Apple.md | 2 KB | Mar 3, 2024").html;
    expect(h).toContain(">2 KB<");
    expect(h).toContain(">Mar 3, 2024<");
  });

  it("shows a folder's item count on GNOME and -- on macOS", function () {
    const h = pane.folder("Fruits\n  a.md\n  b.md", { now: "2026-01-01T00:00:00" }).html;
    expect(h).toContain('<span data-os="linux">2 items</span>');
    expect(h).toContain('<span data-os="mac">--</span>');
  });
});
