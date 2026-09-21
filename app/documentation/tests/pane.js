// The docs build renders folder windows with app/helper/pane; the old finder still renders
// what pane doesn't (editor windows, inline file names). No app or database needed.
const fs = require("fs-extra");
const path = require("path");
const html = require("documentation/build/html");
const pane = require("helper/pane");

const FOLDER = '<pre class="folder" title="Site"><code>Pages\n  About.txt\nPosts</code></pre>';
const TEXT = '<pre class="text" title="Post.txt"><code>Hello</code></pre>';

describe("documentation folder windows (pane)", function () {
  it("replaces pre.folder with a pane window", async function () {
    const out = await html(FOLDER);
    expect(out).toContain('<figure class="pane"');
    expect(out).toContain('aria-label="Site"');
    expect(out).not.toContain("<pre");
    expect(out).not.toContain("finder window");
  });

  it("leaves the editor windows and inline file names to the old finder", async function () {
    const out = await html(FOLDER + TEXT + '<p><code class="file txt">a.txt</code></p>');
    expect(out).toContain('<figure class="pane"');
    expect(out).toContain("finder window text");
    expect(out).toContain('class="icon');
    expect(out.match(/<figure class="pane"/g).length).toBe(1);
  });

  it("uses one now for the whole build, so every window on every page agrees", async function () {
    expect(await html(FOLDER)).toBe(await html(FOLDER));
    // fresh: the build's own time, not the module's constant: the newest row is dated today
    // (a minute back: the newest row can be a minute before the build if it ran just after midnight UTC)
    const [y, m, d] = pane.isoNow(new Date(Date.now() - 60000)).slice(0, 10).split("-").map(Number);
    const out = await html('<pre class="folder"><code>a.md\nb.md\nc.md</code></pre>');
    expect(out).toContain(`data-os="win">${m}/${d}/${y} `); // some row is dated today (Explorer writes the full date)
  });

  it("ships the head script that picks the skin, and the stylesheet is in the docs bundle", async function () {
    const head = await fs.readFile(path.join(__dirname, "../../views/partials/head.html"), "utf8");
    expect(head).toContain(`<script>${pane.assets().js}</script>`); // change pane's script and this must follow
    const css = await fs.readFile(path.join(__dirname, "../build/css.js"), "utf8");
    expect(css).toContain("pane.assets().css");
  });
});
