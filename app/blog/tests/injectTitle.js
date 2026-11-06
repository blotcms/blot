const cheerio = require("cheerio");

describe("injectTitle", function () {
  require("./util/setup")();

  async function enableInjectTitle() {
    const plugins = {
      ...this.blog.plugins,
      injectTitle: { enabled: true, options: { manuallyDisabled: false } },
    };

    await this.template({
      "layout.html": "<!doctype html><html><body>{{{body}}}</body></html>",
      "entry.html": "<article>{{{entry.html}}}</article>",
    });

    await this.blog.update({ plugins });
    await this.blog.rebuild();
  }

  beforeEach(async function () {
    await enableInjectTitle.call(this);
  });

  it("adds a derived heading for Markdown entries without headings", async function () {
    await this.write({
      path: "/Notes/Project Update.md",
      content: [
        "Link: /project-update",
        "",
        "Weekly summary from the vault.",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/project-update");
    const $ = cheerio.load(body);

    const article = $("article");

    expect(article.children().first().is("h1")).toBe(true);
    expect(article.find("h1").first().text()).toBe("Project Update");
    expect(article.find("p").first().text()).toContain("Weekly summary");
  });

  it("leaves existing headings untouched", async function () {
    await this.write({
      path: "/Notes/Existing.md",
      content: [
        "Link: /existing",
        "",
        "# Already titled",
        "",
        "Body copy follows the explicit heading.",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/existing");
    const $ = cheerio.load(body);

    const headings = $("article h1");

    expect(headings.length).toBe(1);
    expect(headings.first().text()).toBe("Already titled");
  });

  it("ignores non-Markdown entries", async function () {
    await this.write({
      path: "/Notes/Plain.txt",
      content: [
        "Link: /plain",
        "",
        "Captured without an Obsidian heading.",
      ].join("\n"),
    });
    await this.blog.rebuild();

    const body = await this.text("/plain");
    const $ = cheerio.load(body);

    expect($("article h1").length).toBe(0);
    expect($("article p").first().text()).toContain(
      "Captured without an Obsidian heading."
    );
  });
});
