// The docs build renders the folder and editor windows with app/helper/pane; the old finder
// still renders what pane doesn't (inline file names). No app or database needed.
const fs = require("fs-extra");
const path = require("path");
const html = require("documentation/build/html");
const pane = require("helper/pane");

const FOLDER = '<pre class="folder" title="Site"><code>Pages\n  About.txt\nPosts</code></pre>';
const TEXT = '<pre class="text" title="Post.txt"><code>Hello</code></pre>';
const CODE = '<pre class="code"><code>&lt;p&gt;Hi&lt;/p&gt;</code></pre>';

describe("documentation windows (pane)", function () {
  it("replaces pre.folder with a pane window", async function () {
    const out = await html(FOLDER);
    expect(out).toContain('<figure class="pane'); // a "pane-yd" class follows when some row is dated yesterday
    expect(out).toContain('aria-label="Site"');
    expect(out).not.toContain("<pre");
    expect(out).not.toContain("finder window");
  });

  it("renders the editor windows with pane, and leaves inline file names to the old finder", async function () {
    const out = await html(FOLDER + TEXT + CODE + '<p><code class="file txt">a.txt</code></p>');
    expect(out).toContain('<figure class="pane pane-ed pane-bare" data-view="text" aria-label="Post.txt"');
    expect(out).toContain('<figure class="pane pane-ed" data-view="code"');
    expect(out).not.toContain("finder window");
    expect(out).toContain('class="icon'); // code.file: still the finder's
    expect(out.match(/<figure class="pane/g).length).toBe(3);
    expect(out).not.toMatch(/<pre class="(text|code)/); // the old blocks are gone
  });

  it("keeps a text window's chrome for with-chrome, and highlights code in the named language", async function () {
    const out = await html('<pre class="text with-chrome" title="Post.org"><code>* Heading</code></pre><pre class="code javascript"><code>var a = 1;</code></pre>');
    expect(out).toContain('<figure class="pane pane-ed" data-view="text" aria-label="Post.org"');
    expect(out).toContain('data-lang="javascript"');
    expect(out).toContain("pane-t-");
    expect(out).not.toContain("hljs");
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
