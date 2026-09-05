const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const blogger = require("../index");

describe("Blogger importer", function () {
  const legacyFixture = path.join(__dirname, "fixtures", "export.xml");
  const atomFixture = path.join(__dirname, "fixtures", "export.atom");

  // The full import pipeline runs helper.download_images / download_pdfs, which
  // fetch() the external asset URLs embedded in export.xml (e.g.
  // https://blogger.googleusercontent.com/...). Those real network calls make
  // the pipeline specs depend on CI egress and time out intermittently
  // (helper/download_images.js has its own 5s timeout that collides with
  // Jasmine's). Stub fetch so downloads fail fast and offline; none of these
  // specs assert on downloaded asset content.
  let realFetch;

  beforeAll(function () {
    realFetch = global.fetch;
    global.fetch = function () {
      return Promise.resolve({
        ok: false,
        status: 404,
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({}),
      });
    };
  });

  afterAll(function () {
    global.fetch = realFetch;
  });

  it("selects published posts and pages and maps Atom fields", async function () {
    const entries = await blogger.parse(await fs.readFile(legacyFixture, "utf8"));
    expect(entries.length).toBe(5);
    expect(entries.map(({ id }) => id)).toEqual([
      "post-1",
      "page-1",
      "post-2",
      "post-3",
      "post-4",
    ]);
    expect(entries[0].tags).toEqual(["News", "Two Words"]);
    expect(entries[0].html).toContain(
      'src="https://blogger.googleusercontent.com/img/b/ABC/s3093/IMG_4534.jpg"'
    );
    expect(entries[0].html).toContain(
      'href="https://blogger.googleusercontent.com/img/b/ABC/s3093/IMG_4534.jpg"'
    );
    expect(entries[0].html).not.toContain("/s320/");
    expect(entries[0].html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(entries[0].html).toContain(
      'href="https://example.blogspot.com/2020/01/hello-world.html"'
    );
    expect(entries[0].permalink).toBe("https://example.blogspot.com/2020/01/shared.html");
    expect(entries[0].dateStamp).toBe(Date.parse("2020-01-02T03:04:05Z"));
    expect(entries[1].page).toBe(true);
    expect(entries[2].title).toBe("shared");
    expect(entries[2].slug).toBe("2020-01-shared-2");
    expect(entries[3].slug).toBe("a-☃-weird.name");
    expect(entries[4].title).toBe("hello-world");
    expect(entries[4].slug).toBe("2020-01-hello-world");
  });

  it("parses current Blogger Atom exports with blogger:type and filename", async function () {
    const entries = await blogger.parse(await fs.readFile(atomFixture, "utf8"));
    expect(entries.length).toBe(3);
    expect(entries.map(({ id }) => id)).toEqual([
      "tag:blogger.com,1999:blog-1.post-1",
      "tag:blogger.com,1999:blog-1.page-1",
      "tag:blogger.com,1999:blog-1.post-2",
    ]);
    expect(entries[0].permalink).toBe("/2014/07/kinship-terms.html");
    expect(entries[0].slug).toBe("2014-07-kinship-terms");
    expect(entries[0].dateStamp).toBe(Date.parse("2014-07-28T03:35:00Z"));
    expect(entries[0].html).toContain("<strong>world</strong>");
    expect(entries[0].html).toContain("<em>friends</em>");
    expect(entries[0].html).toContain("<table>");
    expect(entries[0].html).toContain(
      'href="https://koalanguage.blogspot.com/2021/11/kion-fari.html"'
    );
    expect(entries[1].page).toBe(true);
    expect(entries[1].slug).toBe("p-about");
    expect(entries[2].title).toBe("kion-fari");
    expect(entries[2].slug).toBe("2021-11-kion-fari");
  });

  it("parses site URL input into a hostname", function () {
    expect(blogger.parseSiteHost("")).toBe("");
    expect(blogger.parseSiteHost("  ")).toBe("");
    expect(blogger.parseSiteHost("https://koalanguage.blogspot.com/")).toBe(
      "koalanguage.blogspot.com"
    );
    expect(blogger.parseSiteHost("http://www.Example.Blogspot.com/path")).toBe(
      "example.blogspot.com"
    );
    expect(blogger.parseSiteHost("koalanguage.blogspot.com")).toBe(
      "koalanguage.blogspot.com"
    );
    expect(function () {
      blogger.parseSiteHost("not a url");
    }).toThrow();
  });

  it("promotes linked Blogger thumbnails to the full-size image URL", function () {
    const parse = require("../parse");
    const full =
      "https://blogger.googleusercontent.com/img/b/ABC/s3093/IMG_4534.jpg";
    const thumb =
      "https://blogger.googleusercontent.com/img/b/ABC/s320/IMG_4534.jpg";
    const other =
      "https://blogger.googleusercontent.com/img/b/ABC/s1600/other.jpg";
    const opaqueFull =
      "https://blogger.googleusercontent.com/img/a/AVvXsEgFVMWOiw9WlUf_pZvWu1U3iko0IikKVMN_yg79hHGSISG9NmEpmKXUHSF1cgb3HnaUGwLSamO0Lrfk93DWBjrjofgY-eO_fSUpL_xRnoByt0VBxPByLREtqG_4LFaItKLclPTyAloonludCg5_aIJ3nGBO9BWK2RHg5GQVN2hmUkwitGVjNFNdmzTRjCI";
    const opaqueThumb = opaqueFull + "=w320-h269";
    const opaqueOther =
      "https://blogger.googleusercontent.com/img/a/AVvXsEioelOHnuW_OMF24Sw2jt4PBuTvhF2-jhbFOGTL2YnmkSjtXiDXGrv6IWFKvtZA696TRWDRBVpiN7ujjtlXBJXqtvZzSWCE7Dd70mY4ja-jfhV7ZtAOjusjibOdzCzMuSrlckggHFlIAAXWIyrzfzfEQ_LdLfhP_3KxM7N5XGbPzrdQpJwlYj5Hy2zY2Qw";

    expect(
      parse.preferFullSizeImages(
        `<a href="${full}"><img src="${thumb}"></a>`
      )
    ).toContain(`src="${full}"`);

    expect(
      parse.preferFullSizeImages(
        `<a href="${opaqueFull}"><img src="${opaqueThumb}"></a>`
      )
    ).toContain(`src="${opaqueFull}"`);

    expect(
      parse.preferFullSizeImages(
        `<a href="${other}"><img src="${thumb}"></a>`
      )
    ).toContain(`src="${thumb}"`);

    expect(
      parse.preferFullSizeImages(
        `<a href="${opaqueOther}"><img src="${opaqueThumb}"></a>`
      )
    ).toContain(`src="${opaqueThumb}"`);

    expect(
      parse.preferFullSizeImages(
        `<a href="https://example.blogspot.com/post.html"><img src="${thumb}"></a>`
      )
    ).toContain(`src="${thumb}"`);
  });

  it("moves trailing breaks outside bold tags before Markdown conversion", function () {
    const parse = require("../parse");

    expect(
      parse.hoistTrailingBreaks(
        `<b>
    1.1.2 Particle Categories
    <br />
    <br />
  </b>`
      )
    ).toBe("<b>\n    1.1.2 Particle Categories\n    </b><br><br>");

    expect(
      parse.hoistTrailingBreaks("<strong>Title<br/><br/></strong><p>Next</p>")
    ).toBe("<strong>Title</strong><br><br><p>Next</p>");

    // Breaks that separate content inside the tag stay put.
    expect(parse.hoistTrailingBreaks("<b>keep<br/>middle<br/><br/></b>")).toBe(
      "<b>keep<br>middle</b><br><br>"
    );
  });

  it("rebases same-site links when a site host is provided", async function () {
    const xml = await fs.readFile(legacyFixture, "utf8");
    const entries = await blogger.parse(xml, "example.blogspot.com");
    expect(entries[0].permalink).toBe("/2020/01/shared.html");
    expect(entries[0].html).toContain('href="/2020/01/hello-world.html"');
    expect(entries[0].html).toContain('href="https://other.example/page"');
    expect(entries[1].permalink).toBe("/p/about.html");

    const atom = await blogger.parse(
      await fs.readFile(atomFixture, "utf8"),
      "https://www.koalanguage.blogspot.com"
    );
    expect(atom[0].html).toContain('href="/2021/11/kion-fari.html"');
    expect(atom[0].html).toContain(
      'href="https://seadilanguage.blogspot.com/other.html"'
    );
  });

  it("writes Markdown, metadata, pages, and collision-safe paths", async function () {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "blogger-import-"));
    await blogger(legacyFixture, output, () => {});

    const first = await fs.readFile(path.join(output, "2020", "01-02-2020-01-shared.txt"), "utf8");
    const duplicate = path.join(output, "2020", "01-02-2020-01-shared-2.txt");
    const page = await fs.readFile(path.join(output, "Pages", "p-about.txt"), "utf8");
    expect(first).toContain("Tags: News, Two Words");
    expect(first).toContain("Link: https://example.blogspot.com/2020/01/shared.html");
    expect(first).toContain("Hello **world**.");
    expect(first).toContain(
      "[other post](https://example.blogspot.com/2020/01/hello-world.html)"
    );
    expect(await fs.pathExists(duplicate)).toBe(true);
    expect(page).toContain("# About");
    await fs.remove(output);
  });

  it("writes Markdown with rebased links when siteHost is set", async function () {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "blogger-rebase-"));
    await blogger(atomFixture, output, () => {}, {
      siteHost: "koalanguage.blogspot.com",
    });

    const post = await fs.readFile(
      path.join(output, "2014", "07-28-2014-07-kinship-terms.txt"),
      "utf8"
    );
    expect(post).toContain("Link: /2014/07/kinship-terms.html");
    expect(post).toContain("[post](/2021/11/kion-fari.html)");
    expect(post).toContain("[elsewhere](https://seadilanguage.blogspot.com/other.html)");
    await fs.remove(output);
  });

  it("writes Markdown from current Atom exports using blogger:filename paths", async function () {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "blogger-atom-import-"));
    await blogger(atomFixture, output, () => {});

    const post = await fs.readFile(
      path.join(output, "2014", "07-28-2014-07-kinship-terms.txt"),
      "utf8"
    );
    const page = await fs.readFile(path.join(output, "Pages", "p-about.txt"), "utf8");
    expect(post).toContain("Link: /2014/07/kinship-terms.html");
    expect(post).toContain("Hello **world** and *friends*.");
    expect(post).toContain("| Term | Meaning |");
    expect(post).toContain("| --- | --- |");
    expect(post).toContain("| ama | mother |");
    expect(post).toContain(
      "[post](https://koalanguage.blogspot.com/2021/11/kion-fari.html)"
    );
    expect(page).toContain("# About");
    expect(page).toContain("Link: /p/about.html");
    await fs.remove(output);
  });

  it("formats emphasis with asterisks and tables as Markdown tables", async function () {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "blogger-md-format-"));
    await blogger(atomFixture, output, () => {});

    const post = await fs.readFile(
      path.join(output, "2014", "07-28-2014-07-kinship-terms.txt"),
      "utf8"
    );

    expect(post).toContain("*friends*");
    expect(post).not.toContain("_friends_");
    expect(post).toContain("**1.1.2 Particle Categories**");
    expect(post).toMatch(/\| Term \| Meaning \|/);
    expect(post).toMatch(/\| --- \| --- \|/);
    expect(post).toMatch(/\| ama \| mother \|/);
    await fs.remove(output);
  });
});
