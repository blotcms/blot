const fs = require("fs-extra");
const build = require("build");
const plugins = require("build/plugins");
const markdown = require("build/converters/markdown");
const templates = require("templates");

beforeAll(async function () {
  await templates({ watch: false });
}, 10 * 1000);

describe("callouts plugin integration", function () {
  require("build/tests/plugins/util/setup")();

  const fixture = __dirname + "/examples/markdown-callouts.md";

  async function buildFixture(context, enabled) {
    context.blog.plugins.callouts = { enabled, options: {} };
    const contents = fs.readFileSync(fixture, "utf8");
    await test.folder.writeFiles(context.blog.id, {
      "/callouts.md": contents,
    });
    return build(context.blog, "/callouts.md");
  }

  it("converts callouts through the Markdown build path when enabled", async function () {
    const entry = await buildFixture(this, true);
    const html = entry.html;

    expect(html).toContain(
      '<div class="callout" data-callout="note" data-callout-original="note">'
    );
    expect(html).toContain(
      '<span class="callout-title-inner">Custom <strong>Warning</strong></span>'
    );
    expect(html).toContain(
      '<span class="callout-title-inner">Task List</span>'
    );
    expect(html).toContain(
      'class="callout is-expanded" data-callout="info" data-callout-original="info" data-callout-fold="+"'
    );
    expect(html).toContain(
      'class="callout is-collapsed" data-callout="danger" data-callout-original="danger" data-callout-fold="-"'
    );
    expect(html).toContain(
      'class="callout-title" role="button" tabindex="0" aria-expanded="true"'
    );
    expect(html).toContain(
      'class="callout-title" role="button" tabindex="0" aria-expanded="false"'
    );
    expect(html).toContain(
      'data-callout="question" data-callout-original="faq"'
    );
    expect(html).toContain(
      'data-callout="danger" data-callout-original="error"'
    );
    expect(html).toContain(
      'data-callout="abstract" data-callout-original="summary"'
    );
    expect(html).toContain(
      'data-callout="note" data-callout-original="custom_type"'
    );
    expect(html).toContain('data-callout="tip" data-callout-original="tip"');
    expect(html).toContain(
      '<span class="callout-title-inner">Custom Type</span>'
    );
    expect(html).toMatch(/<div class="callout-content">\s*<\/div>/);
    expect(html).toContain(
      "<blockquote>\n<p>This is a normal quote with [!note] later.</p>\n</blockquote>"
    );
    expect(html).toContain(
      "<code>&gt; [!note]\n&gt; Code should not change.</code>"
    );
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
  });

  it("leaves the same Markdown as blockquotes when disabled", async function () {
    const entry = await buildFixture(this, false);
    expect(entry.html).toContain("<blockquote>");
    expect(entry.html).toContain("[!note]");
    expect(entry.html).not.toContain('class="callout"');
  });

  it("loads both public assets only when enabled", async function () {
    this.blog.plugins.callouts = { enabled: true, options: {} };
    const css = await plugins.load("css", this.blog.plugins);
    expect(css).toContain(".callout[data-callout]");
    expect(css).toContain('.callout[data-callout="warning"]');
    expect(css).not.toContain("data:image/svg+xml;base64");
    expect(css).toContain(".callout-fold-ready.is-collapsed");
    expect(css).not.toContain("details.callout");
    expect(css).not.toContain("summary.callout-title");
    expect(css).not.toContain("--callout-icon");
    expect(css).not.toContain(".callout-icon {");
    const js = await plugins.load("js", this.blog.plugins);
    expect(js).toContain("data-callout-fold");
    expect(js).toContain("aria-expanded");
  });

  it("retains all Markdown converter source extensions", function () {
    [".md", ".markdown", ".txt", ".text"].forEach(function (extension) {
      expect(markdown.is("/post" + extension)).toBe(true);
    });
  });

  it("does not post-process HTML from non-Markdown converters", async function () {
    this.blog.plugins.callouts = { enabled: true, options: {} };
    const html = "<blockquote><p>[!note] Title</p></blockquote>";
    const [result] = await plugins.convert(this.blog, "/post.html", html);
    expect(result).toBe(html);
  });
});
