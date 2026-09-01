describe("backlinks", function () {
  require("./util/setup")();

  const backlinksTemplate = {
    "entry.html":
      "{{#entry}}{{#backlinks.length}}Backlinks: {{#backlinks}}{{title}}{{/backlinks}}{{/backlinks.length}}{{/entry}}",
  };

  it("renders backlinks when another post links via markdown", async function () {
    await this.write({ path: "/target.txt", content: "Title: Target\n\nContent." });
    await this.write({
      path: "/linker.txt",
      content: "Title: Linker\n\n[see target](/target)",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/target");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("Linker");
  });

  it("renders backlinks when another post links via wikilinks", async function () {
    await this.write({ path: "/first.txt", content: "Foo" });
    await this.write({
      path: "/second.txt",
      content: "Title: Second\n\n[[first]]",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/first");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("Second");
  });

  it("renders multiple backlinks when several posts link to the same entry", async function () {
    await this.write({
      path: "/target.txt",
      content: "Title: Target\n\nContent.",
    });
    await this.write({
      path: "/linker-a.txt",
      content: "Title: Linker A\n\n[target](/target)",
    });
    await this.write({
      path: "/linker-b.txt",
      content: "Title: Linker B\n\n[target](/target)",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/target");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("Linker A");
    expect(body).toContain("Linker B");
  });

  it("renders no backlinks when nothing links to the entry", async function () {
    await this.write({
      path: "/standalone.txt",
      content: "Title: Standalone\n\nNo one links here.",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/standalone");
    expect(body).not.toContain("Backlinks:");
  });


  it("does not create a backlink from a resolved link to a plain local file", async function () {
    const fs = require("fs-extra");
    await fs.outputFile(this.blogDirectory + "/beach.jpg", "fake image data");

    await this.write({
      path: "/vacation.txt",
      content: "Title: Vacation\n\n[Download](beach.jpg)",
    });
    await this.template(backlinksTemplate);

    // The link resolves to /beach.jpg (a real file, not a post),
    // so it must not show up as a backlink anywhere.
    const body = await this.text("/vacation");
    expect(body).not.toContain("Backlinks:");
  });

  it("still creates a backlink from an anchor sharing a path with one the autoImage plugin removed", async function () {
    // /photo.jpg is a real file, but also deliberately set as another
    // entry's custom permalink, so the two collide.
    const fs = require("fs-extra");
    await fs.outputFile(this.blogDirectory + "/photo.jpg", "fake image data");

    await this.write({
      path: "/other.txt",
      content: "Title: Other\nLink: /photo.jpg\n\nContent.",
    });
    await this.write({
      path: "/linker.txt",
      content:
        // The bare [photo.jpg](photo.jpg) link resolves to /photo.jpg
        // and gets converted by the default autoImage plugin into an
        // <img> - removing that anchor entirely. The second, separate
        // link is unrelated and must still register as a real
        // backlink to Other, even though it shares the same resolved
        // path with the anchor that was just removed.
        "Title: Linker\n\n[photo.jpg](photo.jpg)\n\n[See other](/photo.jpg)",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/photo.jpg");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("Linker");
  });

  it("resolves backlinks from double-encoded href values", async function () {
    await this.write({
      path: "/target.txt",
      content: "Title: Target\nLink: /a%2520b\n\nContent.",
    });
    await this.write({
      path: "/linker.txt",
      content:
        'Title: Linker\n\n<p><a href="/a%2520b">Link to target</a></p>',
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/a%2520b");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("Linker");
  });

  it("renders backlinks when the linked page has umlauts (ä, ü, ö) in its URL", async function () {
    // Page with umlaut in URL (explicit Link so the URL is /grüße)
    await this.write({
      path: "/grüße.txt",
      content: "Title: Grüße\nLink: /grüße\n\nContent here.",
    });
    // Link using raw HTML with percent-encoded href. This simulates output from
    // converters (e.g. Pandoc) that encode unicode in URLs; internalLinks
    // then sees "/gr%C3%BC%C3%9Fe" and getByUrl must resolve it to the entry
    // stored under decoded "/grüße" or the backlink is never added.
    await this.write({
      path: "/linker.txt",
      content:
        'Title: Linker\n\n<p><a href="/gr%C3%BC%C3%9Fe">Link to page</a></p>',
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/grüße");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("Linker");
  });

  it("renders backlinks when the linking source has umlauts in its filename", async function () {
    await this.write({ path: "/target.txt", content: "Title: Target\n\nContent." });
    await this.write({
      path: "/grüße-linker.txt",
      content:
        'Title: Grüße Linker\n\n[markdown link](/target) and <a href="/target">html link</a>',
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/target");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("Grüße Linker");
  });
});

describe("backlinks edge cases", function () {
  require("./util/setup")();

  const backlinksTemplate = {
    "entry.html":
      "{{#entry}}{{#backlinks.length}}Backlinks: {{#backlinks}}{{title}}{{/backlinks}}{{/backlinks.length}}{{/entry}}",
  };

  it("does not create a backlink for self-links", async function () {
    await this.write({
      path: "/self.txt",
      content: "Title: Self\n\n[self](/self)",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/self");
    expect(body).not.toContain("Backlinks:");
  });

  it("deduplicates multiple links from the same source post", async function () {
    await this.write({ path: "/target.txt", content: "Title: Target" });
    await this.write({
      path: "/linker.txt",
      content: "Title: Linker\n\n[first](/target) and [second](/target)",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/target");
    expect(body).toContain("Backlinks:");
    expect((body.match(/Linker/g) || []).length).toEqual(1);
  });

  it("resolves backlinks when the link includes a fragment or query", async function () {
    await this.write({ path: "/target.txt", content: "Title: Target" });
    await this.write({
      path: "/linker-fragment.txt",
      content: "Title: Linker Fragment\n\n[target](/target#section)",
    });
    await this.write({
      path: "/linker-query.txt",
      content: "Title: Linker Query\n\n[target](/target?x=1)",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/target");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("Linker Fragment");
    expect(body).toContain("Linker Query");
  });

  it("ignores external URLs when building backlinks", async function () {
    await this.write({ path: "/target.txt", content: "Title: Target" });
    await this.write({
      path: "/linker-external.txt",
      content:
        "Title: Linker External\n\n[external](https://example.com/target)",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/target");
    expect(body).not.toContain("Backlinks:");
  });

  it("resolves backlinks from HTML anchors in .html source files", async function () {
    await this.write({ path: "/target.txt", content: "Title: Target" });
    await this.write({
      path: "/linker.html",
      content:
        '<html><body><a href="/target">via raw html file</a></body></html>',
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/target");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("linker");
  });

  it("resolves backlinks from markdown files with accented slugs", async function () {
    await this.write({
      path: "/café.md",
      content: "Title: Café\nLink: /caf%C3%A9\n\nTarget entry.",
    });
    await this.write({
      path: "/md-linker.md",
      content: "Title: MD Linker\n\n[visit café](/caf%C3%A9)",
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/caf%C3%A9");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("MD Linker");
  });

  it("normalizes unicode backlink targets across formats and excludes near-misses", async function () {
    await this.write({
      path: "/resume-target.txt",
      content: "Title: Résumé Target\nLink: /résumé\n\nCanonical target.",
    });

    const fixtures = [
      {
        path: "/md-inline.txt",
        content:
          "Title: Markdown Inline\n\n[encoded](/r%C3%A9sum%C3%A9) and <a href=\"/résumé\">decoded</a>",
        shouldBacklink: true,
        title: "Markdown Inline",
      },
      {
        path: "/html-inline.txt",
        content: 'Title: HTML Inline\n\n<a href="/résumé">decoded unicode</a>',
        shouldBacklink: true,
        title: "HTML Inline",
      },
      {
        path: "/wikilink.txt",
        content: "Title: Wikilink\n\n[[résumé]]",
        shouldBacklink: true,
        title: "Wikilink",
      },
      {
        path: "/trailing-slash.txt",
        content: "Title: Trailing Slash\n\n[miss](/résumé/)",
        shouldBacklink: false,
        title: "Trailing Slash",
      },
      {
        path: "/case-mismatch.txt",
        content: "Title: Case Mismatch\n\n[miss](/Résumé)",
        shouldBacklink: false,
        title: "Case Mismatch",
      },
      {
        path: "/external-host.txt",
        content: "Title: External Host\n\n[miss](https://example.com/r%C3%A9sum%C3%A9)",
        shouldBacklink: false,
        title: "External Host",
      },
      {
        path: "/other-fragment.txt",
        content: "Title: Other Fragment\n\n[miss](/other#résumé)",
        shouldBacklink: false,
        title: "Other Fragment",
      },
    ];

    for (const fixture of fixtures) {
      await this.write({ path: fixture.path, content: fixture.content });
    }

    await this.template(backlinksTemplate);

    const body = await this.text("/résumé");
    expect(body).toContain("Backlinks:");

    for (const fixture of fixtures) {
      if (fixture.shouldBacklink) {
        expect(body).toContain(fixture.title);
      } else {
        expect(body).not.toContain(fixture.title);
      }
    }

    expect((body.match(/Markdown Inline/g) || []).length).toEqual(1);
  });

  it("resolves backlinks from Google Docs exports (.gdoc)", async function () {
    await this.write({ path: "/target.txt", content: "Title: Target" });
    await this.write({
      path: "/gdoc-linker.gdoc",
      content:
        '<html><body><p><a href="/target">link from google docs html export</a></p></body></html>',
    });
    await this.template(backlinksTemplate);

    const body = await this.text("/target");
    expect(body).toContain("Backlinks:");
    expect(body).toContain("gdoc-linker");
  });
});
