const cheerio = require("cheerio");

describe("wikilinks", function () {
  require("./util/setup")();

  global.test.timeout(10 * 1000); // 10 second timeout

  async function enableWikilinks() {
    const plugins = {
      ...this.blog.plugins,
      wikilinks: { enabled: true, options: {} },
    };

    await this.template({ "entry.html": "{{{entry.html}}}" });
    await this.blog.update({ plugins });
    await this.blog.rebuild();
  }

  async function enableInjectTitle() {
    const plugins = {
      ...this.blog.plugins,
      injectTitle: { enabled: true, options: { manuallyDisabled: false } },
    };

    await this.blog.update({ plugins });
    await this.blog.rebuild();
  }

  beforeEach(async function () {
    await enableWikilinks.call(this);
  });

  it("resolves embedded images after root file removal", async function () {
    const imageBuffer = await global.test.fake.pngBuffer();

    await this.write({ path: "/Image.jpg", content: imageBuffer });
    await this.blog.rebuild();

    await this.remove("/Image.jpg");
    await this.blog.rebuild();

    await this.write({ path: "/Images/Image.jpg", content: imageBuffer });
    await this.blog.rebuild();

    await this.write({
      path: "/post.txt",
      content: "Link: post\n\n![[Image.jpg]]",
    });
    await this.blog.rebuild();

    const body = await this.text("/post");
    expect(body).toContain("/_image_cache/");
    expect(body).not.toContain('"/Image.jpg"');
  });

  it("renders unresolved wikilinks without altering their href", async function () {
    await this.write({
      path: "/Missing.md",
      content: [
        "Title: Missing",
        "Link: missing",
        "",
        "See [[Nonexistent Note]].",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/missing");
    expect(body).toContain('href="Nonexistent Note"'); // Missing targets keep original href
    expect(body).toContain(">Nonexistent Note<");
  });

  it("resolves wikilinks by path for relative, absolute, and parent lookups", async function () {
    await this.write({
      path: "/Fruits/Apple.md",
      content: ["Title: Apple", "Link: fruits/apple", "", "# Apple"].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Fruits/Pear.txt",
      content: ["Title: Pear", "Link: fruits/pear", "", "# Pear"].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Fruits/Tasty/Mango.md",
      content: ["Title: Mango", "Link: fruits/tasty/mango", "", "# Mango"].join(
        "\n"
      ),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Introduction.md",
      content: [
        "Title: Introduction",
        "Link: introduction",
        "",
        "[[Fruits/Apple]]",
        "",
        "[[./Fruits/Pear]]",
        "",
        "[[/Fruits/Tasty/Mango.md]]",
      ].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Fruits/Tasty/Notes.md",
      content: [
        "Title: Mango Notes",
        "Link: fruits/tasty/notes",
        "",
        "[[../Apple]]",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const introBody = await this.text("/introduction");
    expect(introBody).toContain('href="/fruits/apple"'); // relative path resolves via byPath
    expect(introBody).toContain(">Apple<");
    expect(introBody).toContain('href="/fruits/pear"'); // ./ relative path resolves via byPath
    expect(introBody).toContain(">Pear<");
    expect(introBody).toContain('href="/fruits/tasty/mango"'); // absolute vault path resolves via byPath
    expect(introBody).toContain(">Mango<");

    const mangoBody = await this.text("/fruits/tasty/notes");
    expect(mangoBody).toContain('href="/fruits/apple"'); // ../ parent traversal resolves via byPath
    expect(mangoBody).toContain(">Apple<");
  });

  it("does not rewrite unresolved absolute wikilink paths for normal links", async function () {
    await this.write({
      path: "/Guide.md",
      content: ["Title: Root Guide", "Link: guide", "", "# Guide"].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Daily/Plan.txt",
      content: [
        "Title: Daily Plan",
        "Link: daily/plan",
        "",
        "[[/Daily/Guide]]",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/daily/plan");
    expect(body).toContain('href="/Daily/Guide"');
    expect(body).not.toContain('href="/guide"');
    expect(body).toContain(">Guide<");
  });

  it("preserves unresolved relative wikilink text", async function () {
    await this.write({
      path: "/Daily/Plan.txt",
      content: [
        "Title: Daily Plan",
        "Link: daily/plan",
        "",
        "[[docs/missing-note]]",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/daily/plan");
    expect(body).toContain('href="docs/missing-note"');
    expect(body).toContain(">docs/missing-note<");
    expect(body).not.toContain(">missing-note<");
  });

  it("resolves filename-only wikilinks by traversing sibling directories", async function () {
    await this.write({
      path: "/Fruits/Tasty/Mango.md",
      content: ["Title: Mango", "Link: fruits/tasty/mango", "", "# Mango"].join(
        "\n"
      ),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Fruits/Apple.md",
      content: ["Title: Apple", "Link: fruits/apple", "", "[[Mango]]"].join(
        "\n"
      ),
    });
    await this.blog.rebuild();

    const body = await this.text("/fruits/apple");
    expect(body).toContain('href="/fruits/tasty/mango"'); // filename search finds Mango in sibling directory
    expect(body).toContain(">Mango<");
  });

  it("falls back to title lookup when path and filename searches fail", async function () {
    await this.write({
      path: "/Plans/Roadmap.md",
      content: [
        "Title: Project Plan",
        "Link: plans/project-plan",
        "",
        "# Overview",
      ].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Plans/Notes.md",
      content: [
        "Title: Planning Notes",
        "Link: plans/notes",
        "",
        "[[Project Plan]]",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/plans/notes");
    expect(body).toContain('href="/plans/project-plan"'); // byTitle resolves when path & filename miss
    expect(body).toContain(">Project Plan<");
  });

  it("resolves wikilinks by title to pages as well as posts", async function () {
    await this.write({
      path: "/About.md",
      content: [
        "Title: About Us",
        "Link: about",
        "Page: yes",
        "",
        "# About this site",
      ].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/TitleLinkPost.md",
      content: [
        "Title: Title Link Test",
        "Link: title-link-test",
        "",
        "See [[About Us]] for more.",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/title-link-test");
    expect(body).toContain('href="/about"');
    expect(body).toContain(">About Us<");
  });

  // todo: work out why this test fails for '[[Heading Demo]]' and '[[#Heading Demo]]' but
  // passes for '[[custom-heading]]' and '[[#custom-heading]]'
  xit("links to same-page headings for all supported anchor syntaxes", async function () {
    await this.write({
      path: "/Headings.md",
      content: [
        "Title: Heading Demo",
        "Link: headings",
        "",
        "# Heading Demo",
        "",
        "## Custom Heading",
        "",
        "Links: [[Heading Demo]] [[#Heading Demo]] [[custom-heading]] [[#custom-heading]]",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/headings");
    expect(body).toContain('href="#heading-demo"'); // matches [[Heading Demo]]
    expect(body).toContain('href="#custom-heading"'); // matches [[custom-heading]] variations
    expect(body).toMatch(/>Heading Demo<.*>Heading Demo</s); // heading text reused for both forms
    expect(body).toMatch(/>Custom Heading<.*>Custom Heading</s);
  });

  // todo: work out why this test fails
  xit("prefers entry matches over same-page headings unless explicitly anchored", async function () {
    await this.write({
      path: "/References/Label.md",
      content: [
        "Title: Label Entry",
        "Link: references/label",
        "",
        "# Label Entry",
      ].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/References/Overview.md",
      content: [
        "Title: Reference Overview",
        "Link: references/overview",
        "",
        "## Label.md",
        "",
        "Links: [[Label.md]] and [[#Label.md]]",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/references/overview");
    expect(body).toContain('href="/references/label"'); // [[Label]] prefers entry lookup
    expect(body).toContain(">Label Entry<");
    expect(body).toContain('href="#label"'); // [[#Label]] links to heading anchor
    expect(body).toContain(">Label<");
  });

  it("prefers filename matches over competing title lookups", async function () {
    await this.write({
      path: "/Notes/Trips/Sunrise.md",
      content: [
        "Title: Mountain Sunrise",
        "Link: notes/trips/sunrise",
        "",
        "# Summit",
      ].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Notes/Drafts/Dawn.md",
      content: [
        "Title: Sunrise.md",
        "Link: notes/drafts/dawn",
        "",
        "# Draft",
      ].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Notes/Guides/Tour.md",
      content: [
        "Title: Tour Guide",
        "Link: notes/guides/tour",
        "",
        "[[Sunrise.md]]",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/notes/guides/tour");
    expect(body).toContain('href="/notes/trips/sunrise"'); // filename match wins ahead of title match
    expect(body).toContain(">Mountain Sunrise<");
    expect(body).not.toContain('href="/notes/drafts/dawn"');
  });

  it("rebuilds dependent entries when a slug-matched wikilink target is saved", async function () {
    await this.write({
      path: "/Notes/Waiting.md",
      content: [
        "Title: Waiting Note",
        "Link: notes/waiting",
        "",
        "This links to [[Future Note]].",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const initialBody = await this.text("/notes/waiting");
    expect(initialBody).toContain('href="Future Note"');
    expect(initialBody).toContain(">Future Note<");

    await this.write({
      path: "/Library/Knowledge.txt",
      content: [
        "Title: Future Note",
        "Link: library/future-note",
        "",
        "# Future Note",
      ].join("\n"),
    });

    await this.blog.rebuild();

    const body = await this.text("/notes/waiting");
    expect(body).toContain('href="/library/future-note"');
    expect(body).toContain(">Future Note<");
    expect(body).not.toContain('href="Future Note"');
  });

  it("rebuilds dependent entries when a filename-matched wikilink target is saved", async function () {
    await this.write({
      path: "/Notes/Waiting.md",
      content: [
        "Title: Waiting Note",
        "Link: notes/waiting",
        "",
        "This links to [[Spec Sheet.md]].",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const initialBody = await this.text("/notes/waiting");
    expect(initialBody).toContain('href="Spec Sheet.md"');
    expect(initialBody).toContain(">Spec Sheet.md<");

    await this.write({
      path: "/Library/Spec Sheet.md",
      content: [
        "Title: Research Summary",
        "Link: library/research-summary",
        "",
        "# Research Summary",
      ].join("\n"),
    });

    await this.blog.rebuild();

    const body = await this.text("/notes/waiting");
    expect(body).toContain('href="/library/research-summary"');
    expect(body).toContain(">Research Summary<");
    expect(body).not.toContain('href="Spec Sheet.md"');
  });

  it("does not match folders when resolving by filename", async function () {
    await this.write({
      path: "/Hello.md",
      content: ["Link: hello", "", "[[Corsi|...more]]"].join("\n"),
    });

    await this.write({
      path: "/Corsi/Index.md",
      content: [
        "Title: Corsi",
        "Link: resolved",
        "",
        "This is the target",
      ].join("\n"),
    });

    await this.blog.rebuild();

    expect(await this.text("/hello")).toContain('<a href="/resolved"'); // match by post title
    expect(await this.text("/hello")).not.toContain('<a href="/Corsi"'); // match for folder name (incorrect)
  });

  // todo: implement a test spec which verifies filename lookup works *without* file extension
  // which is currently not implemented

  it("embeds markdown/text files inline when using embed syntax", async function () {
    await this.write({
      path: "/Notes/Checklist.md",
      content: [
        "Title: Daily Checklist",
        "Link: notes/checklist",
        "",
        "- [ ] Morning routine",
        "- [ ] Review tasks",
        "- [ ] Evening reflection",
      ].join("\n"),
    });
    await this.blog.rebuild();

    await this.write({
      path: "/Daily/Plan.txt",
      content: [
        "Title: Daily Plan",
        "Link: daily/plan",
        "",
        "Here's my checklist:",
        "",
        "![[Notes/Checklist]]",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/daily/plan");
    expect(body).toContain('class="embedded-markdown"');
    expect(body).toContain("Morning routine");
    expect(body).toContain("Review tasks");
    expect(body).toContain("Evening reflection");
    expect(body).not.toContain('href="/notes/checklist"'); // Should be embedded, not linked
  });

  it("hides auto-injected titles when embedding markdown with injectTitle enabled", async function () {
    await enableInjectTitle.call(this);

    await this.write({
      path: "/Snippets/Daily Summary.md",
      content: [
        "Link: snippets/daily-summary",
        "",
        "Auto-heading should be hidden inside embeds.",
      ].join("\n"),
    });

    await this.write({
      path: "/Pages/Guide.md",
      content: [
        "Title: Guide",
        "Link: pages/guide",
        "",
        "# Guide",
        "",
        "![[Snippets/Daily Summary]]",
      ].join("\n"),
    });

    const body = await this.text("/pages/guide");
    const $ = cheerio.load(body);
    const embedded = $(".embedded-markdown").first();

    expect(embedded.length).toBe(1);
    expect(embedded.find("h1.injected-title").length).toBe(0);
    expect(embedded.text()).toContain(
      "Auto-heading should be hidden inside embeds."
    );
  });

  it("keeps authored headings in embedded markdown even when injectTitle is enabled", async function () {
    await enableInjectTitle.call(this);

    await this.write({
      path: "/Snippets/Manual Heading.md",
      content: [
        "Title: Manual Heading Snippet",
        "Link: snippets/manual-heading",
        "",
        "# Authored heading",
        "",
        "Body content stays visible.",
      ].join("\n"),
    });

    await this.write({
      path: "/Pages/Guide.md",
      content: [
        "Title: Guide",
        "Link: pages/guide",
        "",
        "# Guide",
        "",
        "![[Snippets/Manual Heading]]",
      ].join("\n"),
    });

    const body = await this.text("/pages/guide");
    const $ = cheerio.load(body);
    const embedded = $(".embedded-markdown").first();

    expect(embedded.length).toBe(1);
    expect(embedded.find("h1").first().text()).toBe("Authored heading");
    expect(embedded.find("h1.injected-title").length).toBe(0);
    expect(embedded.text()).toContain("Body content stays visible.");
  });

  it("embeds markdown without injected titles when injectTitle is disabled", async function () {
    await this.write({
      path: "/Snippets/No Inject.md",
      content: [
        "Link: snippets/no-inject",
        "",
        "No synthetic title should exist without injectTitle.",
      ].join("\n"),
    });

    await this.write({
      path: "/Pages/Guide.md",
      content: [
        "Title: Guide",
        "Link: pages/guide",
        "",
        "# Guide",
        "",
        "![[Snippets/No Inject]]",
      ].join("\n"),
    });

    const body = await this.text("/pages/guide");
    const $ = cheerio.load(body);
    const embedded = $(".embedded-markdown").first();

    expect(embedded.length).toBe(1);
    expect(embedded.find("h1").length).toBe(0);
    expect(embedded.find("h1.injected-title").length).toBe(0);
    expect(embedded.text()).toContain(
      "No synthetic title should exist without injectTitle."
    );
  });

  it("embeds text files with different extensions (.txt, .text, .markdown)", async function () {
    await this.write({
      path: "/Reference/Notes.txt",
      content: "Important reference information here.",
    });
    await this.write({
      path: "/Main/Post.md",
      content: [
        "Title: Main Post",
        "Link: main/post",
        "",
        "See reference: ![[Reference/Notes]]",
      ].join("\n"),
    });

    const body = await this.text("/main/post");

    expect(body).toContain('class="embedded-markdown"');
    expect(body).toContain("Important reference information here");
  });

  it("tracks dependencies for embedded markdown files", async function () {
    await this.write({
      path: "/Snippets/Template.md",
      content: "Original content",
    });

    await this.write({
      path: "/Pages/Guide.md",
      content: [
        "Title: Guide",
        "Link: pages/guide",
        "",
        "Template: ![[Snippets/Template]]",
      ].join("\n"),
    });
    expect(await this.text("/pages/guide")).toContain("Original content");

    await this.write({
      path: "/Snippets/Template.md",
      content: "Updated content",
    });

    expect(await this.text("/pages/guide")).toContain("Updated content");
  });
});
