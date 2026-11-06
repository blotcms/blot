describe("build", function () {
  const build = require("build");
  const folder = require("storage/folder");

  global.test.blog();

  const buildEntry = (blog, path) =>
    new Promise((resolve, reject) =>
      build(blog, path, (err, entry) => (err ? reject(err) : resolve(entry)))
    );

  beforeEach(function () {
    this.buildAndCheck = ({ path, contents }, expectedEntry, cb) => {
      folder.write(this.blog.id, path, contents).then(
        () => {
          build(this.blog, path, function (err, entry) {
            for (let key in expectedEntry)
              expect(expectedEntry[key]).toEqual(entry[key]);
            cb();
          });
        },
        (err) => {
          fail(err);
          cb();
        }
      );
    };
  });

  it("will use a title to generate an image caption over the alt text", function (done) {
    const contents = `![Alt text here](foo.jpg "Title here")`;
    const path = "/hello.txt";
    // foo.jpg isn't in the folder, so it's baked as a pending CDN URL
    const html = `<p><img src="%%BLOT_CDN%%/folder/v-pending/${this.blog.id}/foo.jpg" title="Title here" alt="Alt text here"><span class="caption">Title here</span></p>`;

    this.blog.plugins.imageCaption = { enabled: true, options: {} };
    this.buildAndCheck({ path, contents }, { html }, done);
  });

  it("will turn titles into title case if plugin is enabled", function (done) {
    const contents = "# Title goes here";
    const path = "/hello.txt";
    const html = '<h1 id="title-goes-here">Title Goes Here</h1>';

    this.blog.plugins.titlecase = { enabled: true, options: {} };
    this.buildAndCheck({ path, contents }, { html }, done);
  });

  it("will turn titles with nested children into title case if plugin is enabled", function (done) {
    const contents = "# Title *goes [with](/here)* children";
    const path = "/hello.txt";
    const html =
      '<h1 id="title-goes-with-children">Title <em>Goes <a href="/here">With</a></em> Children</h1>';

    this.blog.plugins.titlecase = { enabled: true, options: {} };
    this.buildAndCheck({ path, contents }, { html }, done);
  });

  it("defaults embedded media preload to metadata", async function () {
    const path = "/media.txt";
    const contents = [
      '<audio controls src="/audio/example.mp3"></audio>',
      '<video controls src="/video/example.mp4"></video>',
      '<audio controls preload="none" src="/audio/custom.mp3"></audio>',
      '<video controls preload="auto" src="/video/custom.mp4"></video>',
    ].join("\n");

    await folder.write(this.blog.id, path, contents);

    this.blog.plugins.mediaPreload = { enabled: true, options: {} };

    const entry = await buildEntry(this.blog, path);

    expect(entry.html).toContain(
      '<audio controls="" src="/audio/example.mp3" preload="metadata">'
    );
    expect(entry.html).toContain(
      '<video controls="" src="/video/example.mp4" preload="metadata">'
    );
    expect(entry.html).toContain(
      '<audio controls="" preload="none" src="/audio/custom.mp3">'
    );
    expect(entry.html).toContain(
      '<video controls="" preload="auto" src="/video/custom.mp4">'
    );
  });

  [
    {
      label: "txt",
      path: "/math.txt",
      contents: "Inline $a+b$ math",
    },
    {
      label: "md",
      path: "/math.md",
      contents: "Inline $a+b$ math",
    },
    // doesn't yet work because pandoc
    // processes the org file math directly
    // and it seems we can't disable it
    // {
    //   label: "org",
    //   path: "/math.org",
    //   contents: "Inline $$a+b$$ math",
    // },
    {
      label: "rtf",
      path: "/math.rtf",
      contents:
        "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2580\\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\\n\\f0\\fs24 Inline $$a+b$$ math}",
    },
    {
      label: "gdoc",
      path: "/math.gdoc",
      contents:
        '<html><head><meta content="text/html; charset=UTF-8" http-equiv="content-type"></head><body><p>Inline $$a+b$$ math</p></body></html>',
    },
  ].forEach(({ label, path, contents }) => {
    it(`renders katex for ${label} when plugin is enabled`, async function () {
      await folder.write(this.blog.id, path, contents);
      this.blog.plugins.katex = { enabled: true, options: {} };

      const entry = await buildEntry(this.blog, path);
      expect(entry.html).toContain('class="katex"');
      expect(entry.html).not.toContain("$$a+b$$");
      expect(entry.html).not.toContain("$a+b$");
    });
  });

  it("preserves inline and display math when katex is disabled", async function () {
    const path = "/math-disabled.txt";
    const contents = "Inline $a+b$ math\n\n$$c+d$$";

    await folder.write(this.blog.id, path, contents);
    this.blog.plugins.katex = { enabled: false, options: {} };

    const entry = await buildEntry(this.blog, path);
    expect(entry.html).toContain("$a+b$");
    expect(entry.html).toContain("$$c+d$$");
    expect(entry.html).not.toContain('class="math');
    expect(entry.html).not.toContain('class="katex"');
  });
});
