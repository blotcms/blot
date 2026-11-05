describe("folderAssets plugin", function () {
  var build = require("../../../index");
  var fs = require("fs-extra");
  var folder = require("storage/folder");
  var os = require("os");
  var BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");

  global.test.blog();

  var buildEntry = (blog, path) =>
    new Promise((resolve, reject) =>
      build(blog, path, (err, entry) => (err ? reject(err) : resolve(entry)))
    );

  var tokenRegex = (path) =>
    new RegExp(
      `${BLOT_CDN_TOKEN.replace(/%/g, "\\%")}/folder/v-[a-f0-9]{8}/[^"]*${path}`
    );

  it("bakes a relative folder link into a %%BLOT_CDN%%-prefixed, versioned URL at build time", async function () {
    var path = "/Hello.txt";
    var contents = "![Image](photo.jpg)";

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/photo.jpg", "fake image data");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toMatch(tokenRegex("/photo\\.jpg"));
  });

  it("leaves non-matching/ENOENT links untouched", async function () {
    var path = "/Hello.txt";
    var contents = "[Missing](missing.pdf)";

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toContain('href="/missing.pdf"');
    expect(entry.html).not.toContain(BLOT_CDN_TOKEN);
  });

  it("leaves internal .html links untouched", async function () {
    var path = "/Hello.txt";
    var contents = "[Other post](other.html)";

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/other.html", "<p>hi</p>");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toContain('href="/other.html"');
    expect(entry.html).not.toContain(BLOT_CDN_TOKEN);
  });

  it("produces a new version when the dependency file's content changes", async function () {
    var path = "/Hello.txt";
    var contents = "![Image](photo.jpg)";

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/photo.jpg", "version one");

    var entry = await buildEntry(this.blog, path);

    var firstVersion = entry.html.match(/v-([a-f0-9]{8})/)[1];

    await folder.write(this.blog.id, "/photo.jpg", "version two");

    var entry2 = await buildEntry(this.blog, path);

    var secondVersion = entry2.html.match(/v-([a-f0-9]{8})/)[1];

    expect(secondVersion).not.toEqual(firstVersion);
  });

  it("produces the same version for identical content even if the file was rewritten", async function () {
    var path = "/Hello.txt";
    var contents = "![Image](photo.jpg)";

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/photo.jpg", "same content");

    var entry = await buildEntry(this.blog, path);

    var firstVersion = entry.html.match(/v-([a-f0-9]{8})/)[1];

    await folder.write(this.blog.id, "/photo.jpg", "same content");

    var entry2 = await buildEntry(this.blog, path);

    var secondVersion = entry2.html.match(/v-([a-f0-9]{8})/)[1];

    expect(secondVersion).toEqual(firstVersion);
  });

  it("produces the same version when only the file's mtime changes", async function () {
    var path = "/Hello.txt";
    var contents = "![Image](photo.jpg)";
    var blog = this.blog;

    await folder.write(blog.id, path, contents);
    await folder.write(blog.id, "/photo.jpg", "unchanged content");

    var entry = await buildEntry(blog, path);

    var firstVersion = entry.html.match(/v-([a-f0-9]{8})/)[1];

    // The same content, but a different modified time
    var rewritten = os.tmpdir() + "/folderAssets-mtime-" + blog.id + ".jpg";
    await fs.outputFile(rewritten, "unchanged content");
    await folder.writeFrom(blog.id, "/photo.jpg", rewritten, {
      modified: new Date("2030-01-01").getTime(),
    });
    await fs.remove(rewritten);

    var entry2 = await buildEntry(blog, path);

    var secondVersion = entry2.html.match(/v-([a-f0-9]{8})/)[1];

    expect(secondVersion).toEqual(firstVersion);
  });

  // The version is the token helper/contentVersion gives the file at its
  // local path, whatever its size, so moving the lookup onto storage/folder
  // doesn't change a single folder link
  [
    ["a small file", 1024],
    ["a file hashed as a stream", 300 * 1024],
    ["a file above the hashing limit", 6 * 1024 * 1024],
  ].forEach(function ([label, size]) {
    it("bakes the version contentVersion gives " + label, async function () {
      var contentVersion = require("helper/contentVersion");
      var blog = this.blog;

      await folder.write(blog.id, "/Hello.txt", "![Image](photo.jpg)");
      await folder.write(blog.id, "/photo.jpg", Buffer.alloc(size, "x"));

      var expected = await contentVersion.fromFolder(
        blog.id,
        "/photo.jpg",
        await folder.stat(blog.id, "/photo.jpg")
      );
      var entry = await buildEntry(blog, "/Hello.txt");

      expect(entry.html).toContain(
        `${BLOT_CDN_TOKEN}/folder/v-${expected}/${blog.id}/photo.jpg`
      );
    });
  });

  it("finds a file ignoring case, preferring the exact name over a sibling differing only by case", async function () {
    var blog = this.blog;

    await folder.write(this.blog.id, "/Hello.txt", "![A](pics/a.png) ![B](PICS/a.png) ![C](pics/B.PNG)");
    await folder.write(this.blog.id, "/pics/a.png", "lowercase folder");
    await folder.write(this.blog.id, "/Pics/a.png", "capitalised folder");
    await folder.write(this.blog.id, "/pics/b.png", "found by its stored spelling");

    var entry = await buildEntry(blog, "/Hello.txt");

    var links = entry.html.match(/\/folder\/v-[a-f0-9]{8}\/[^"]*/g);

    expect(links.length).toEqual(3);
    expect(links[0]).toMatch(new RegExp("/" + blog.id + "/pics/a\\.png$"));
    // Which of the two folders is first in the directory's listing
    expect(links[1]).toMatch(/\/(Pics|pics)\/a\.png$/);
    expect(links[2]).toMatch(new RegExp("/" + blog.id + "/pics/b\\.png$"));
    expect(entry.dependencies).toContain("/pics/b.png");
  });

  it("bakes a reserved global-static file from the global static directory", async function () {
    var path = "/Hello.txt";
    var contents =
      "![Icon](/icons/search.svg) ![Encoded](/ic%6Fns/search.svg?v=2#a)";

    await folder.write(this.blog.id, path, contents);
    // A same-named file in the blog folder must not win over the global one.
    await folder.write(this.blog.id, "/icons/search.svg", "blog file");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toContain(`src="${BLOT_CDN_TOKEN}/icons/search.svg"`);
    expect(entry.html).toContain(
      `src="${BLOT_CDN_TOKEN}/icons/search.svg?v=2#a"`
    );
    expect(entry.html).not.toContain("/folder/v-");
  });

  it("falls back to the blog folder when a reserved path isn't in the global static directory", async function () {
    var path = "/Hello.txt";
    var contents = "![Font icon](fonts/icon.png) ![Missing](/katex/missing.png)";

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/fonts/icon.png", "blog file");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toMatch(tokenRegex("/fonts/icon\\.png"));
    expect(entry.html).toContain('src="/katex/missing.png"');
    expect(entry.dependencies).toContain("/fonts/icon.png");
    expect(entry.dependencies).toContain("/katex/missing.png");
  });

  it("doesn't let a reserved-looking path escape the global static directory", async function () {
    var path = "/Hello.txt";

    await folder.write(this.blog.id, path, "![Up](/icons/../layout.css)");

    var entry = await buildEntry(this.blog, path);

    // layout.css exists in the global static directory, but not under a
    // reserved prefix, and there is no such file in the blog folder.
    expect(entry.html).not.toContain(BLOT_CDN_TOKEN);
  });

  it("is not optional, so it runs for blogs without a stored folderAssets plugin entry", function () {
    var plugins = require("../../index");

    expect(plugins.list.folderAssets.optional).toBe(false);
  });

  it("bakes poster and srcset candidates and records them as dependencies", async function () {
    var path = "/Hello.txt";
    var contents =
      '<video poster="/poster.jpg"></video>\n\n' +
      '<img src="/a.jpg" srcset="/a.jpg 1x, /a2.jpg 2x">';

    await folder.write(this.blog.id, path, contents);
    for (const file of ["/poster.jpg", "/a.jpg", "/a2.jpg"]) {
      await folder.write(this.blog.id, file, "data " + file);
    }

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toMatch(
      new RegExp(`poster="${BLOT_CDN_TOKEN}/folder/v-[a-f0-9]{8}/[^"]*/poster\\.jpg"`)
    );
    expect(entry.html).toMatch(
      new RegExp(`srcset="[^"]*/a\\.jpg [^"]*1x, [^"]*/a2\\.jpg 2x"`)
    );
    expect(entry.dependencies).toContain("/poster.jpg");
    expect(entry.dependencies).toContain("/a2.jpg");
    expect(entry.dependencies.length).toEqual(
      new Set(entry.dependencies).size
    );
  });

  it("only treats whole path segments as reserved (/fontsFoo is a normal folder)", async function () {
    var path = "/Hello.txt";

    await folder.write(this.blog.id, path, "![Pic](/fontsFoo/pic.png)");
    await folder.write(this.blog.id, "/fontsFoo/pic.png", "blog file");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toMatch(tokenRegex("/fontsFoo/pic\\.png"));
  });

  it("bakes absolute URLs on the blog's own host, and leaves other hosts alone", async function () {
    var config = require("config");
    var path = "/Hello.txt";
    var own = `https://${this.blog.handle}.${config.host}`;
    var contents = `![Own](${own}/photo.jpg) ![Other](https://example.org/photo.jpg)`;

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/photo.jpg", "fake image data");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toMatch(tokenRegex("/photo\\.jpg"));
    expect(entry.html).not.toContain(own);
    expect(entry.html).toContain('src="https://example.org/photo.jpg"');
    expect(entry.dependencies).toContain("/photo.jpg");
  });

  it("bakes a link to the entry's own file but doesn't record it as a dependency", async function () {
    var path = "/Hello.txt";

    await folder.write(this.blog.id, path, "[Source](Hello.txt) [Other](other.pdf)");
    await folder.write(this.blog.id, "/other.pdf", "pdf");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toMatch(tokenRegex("/Hello\\.txt"));
    expect(entry.dependencies).not.toContain("/Hello.txt");
    expect(entry.dependencies).toContain("/other.pdf");
  });

  it("resolves entry-relative poster and srcset paths before baking", async function () {
    var path = "/posts/Hello.txt";
    var contents =
      '<video poster="movie.jpg"></video><img src="/posts/a.jpg" srcset="small.jpg 1x, ../big.jpg 2x">';

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/posts/movie.jpg", "m");
    await folder.write(this.blog.id, "/posts/small.jpg", "s");
    await folder.write(this.blog.id, "/big.jpg", "b");
    await folder.write(this.blog.id, "/posts/a.jpg", "a");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toMatch(new RegExp('poster="' + tokenRegex("/posts/movie\\.jpg").source));
    expect(entry.html).toMatch(tokenRegex("/posts/small\\.jpg 1x"));
    expect(entry.html).toMatch(tokenRegex("/big\\.jpg 2x"));
    expect(entry.dependencies).toContain("/posts/movie.jpg");
    expect(entry.dependencies).toContain("/posts/small.jpg");
    expect(entry.dependencies).toContain("/big.jpg");
  });

  it("records a missing file's path as authored, for the case-insensitive dependents key", async function () {
    var path = "/Hello.txt";

    await folder.write(this.blog.id, path, "![Pic](/Photo.JPG)");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).not.toContain(BLOT_CDN_TOKEN);
    expect(entry.dependencies).toContain("/Photo.JPG");
  });

  it("decodes the path of a missing poster and srcset file before recording it as a dependency", async function () {
    var path = "/Hello.txt";
    var contents =
      '<video poster="/my%20pic.jpg"></video>\n\n' +
      '<img src="/a.jpg" srcset="/a.jpg 1x, /big%20pic.jpg 2x, /50%zz.jpg 3x">';

    await folder.write(this.blog.id, path, contents);

    var entry = await buildEntry(this.blog, path);

    expect(entry.dependencies).toContain("/my pic.jpg");
    expect(entry.dependencies).toContain("/big pic.jpg");
    // a value which can't be decoded is recorded unchanged
    expect(entry.dependencies).toContain("/50%zz.jpg");
    expect(entry.dependencies).not.toContain("/my%20pic.jpg");
  });

  describe("bakeHTML (front matter markup overrides)", function () {
    var bakeHTML = require("../index").bakeHTML;

    it("bakes a string and returns the dependencies, leaving an untouched string as it was", async function () {
      await folder.write(this.blog.id, "/photo.jpg", "fake image data");

      var options = {
        blogID: this.blog.id,
        handle: this.blog.handle,
        domain: this.blog.domain,
        path: "/Hello.txt",
      };

      var baked = await bakeHTML(
        '<p><img src="/photo.jpg"> <a href="/missing%20one.pdf">x</a></p>',
        options
      );

      expect(baked.html).toMatch(tokenRegex("/photo\\.jpg"));
      expect(baked.dependencies).toContain("/photo.jpg");
      expect(baked.dependencies).toContain("/missing one.pdf");

      var untouched = "<p>Hello<br>there</p>";

      expect((await bakeHTML(untouched, options)).html).toEqual(untouched);
    });

    it("bakes teaser and teaserBody set by front matter and records their dependencies", async function () {
      var path = "/Hello.md";
      var contents =
        "---\n" +
        "teaser: '<img src=\"/photo.jpg\">'\n" +
        "teaserBody: '<a href=\"/photo.jpg\">Photo</a> <a href=\"/later.pdf\">Later</a>'\n" +
        "---\n\n" +
        "Body text";

      await folder.write(this.blog.id, path, contents);
      await folder.write(this.blog.id, "/photo.jpg", "fake image data");

      var entry = await buildEntry(this.blog, path);

      expect(entry.teaser).toMatch(tokenRegex("/photo\\.jpg"));
      expect(entry.teaserBody).toMatch(tokenRegex("/photo\\.jpg"));
      expect(entry.teaserBody).toContain('href="/later.pdf"');
      expect(entry.dependencies).toContain("/photo.jpg");
      expect(entry.dependencies).toContain("/later.pdf");
    });
  });

  it("percent-encodes the baked path so a space doesn't split a srcset candidate", async function () {
    var { parseSrcset } = require("blog/render/replaceFolderLinks/shared");
    var path = "/Hello.txt";
    var contents = '<img src="/my pic.jpg" srcset="/my%20pic.jpg 1x, /big%20pic.jpg 2x">';

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/my pic.jpg", "small");
    await folder.write(this.blog.id, "/big pic.jpg", "big");

    var entry = await buildEntry(this.blog, path);

    var srcset = entry.html.match(/srcset="([^"]*)"/)[1];
    var candidates = parseSrcset(srcset);

    expect(candidates.length).toEqual(2);
    expect(candidates[0].url).toMatch(tokenRegex("/my%20pic\\.jpg$"));
    expect(candidates[0].descriptor).toEqual("1x");
    expect(candidates[1].url).toMatch(tokenRegex("/big%20pic\\.jpg$"));
    expect(candidates[1].descriptor).toEqual("2x");
    expect(entry.html).toMatch(new RegExp('src="' + tokenRegex("/my%20pic\\.jpg").source + '"'));
    expect(entry.dependencies).toContain("/my pic.jpg");
    expect(entry.dependencies).toContain("/big pic.jpg");
  });

  it("keeps an encoded '#' or '?' in a file name part of the path", async function () {
    var path = "/Hello.txt";

    await folder.write(this.blog.id, path, `<img src="/it's%20%231%3F.jpg?w=1#top">`);
    await folder.write(this.blog.id, "/it's #1?.jpg", "image");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toMatch(tokenRegex("/it%27s%20%231%3F\\.jpg\\?w=1#top\""));
    expect(entry.dependencies).toContain("/it's #1?.jpg");
  });

  it("re-bakes an already-baked encoded srcset, keeping a missing file's path encoded", async function () {
    var path = "/Hello.txt";
    var baked = (file) => `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${this.blog.id}${file}`;
    var contents = `<img srcset="${baked("/my%20pic.jpg")} 2x, ${baked("/gone%20pic.jpg")} 1x">`;

    await folder.write(this.blog.id, path, contents);
    await folder.write(this.blog.id, "/my pic.jpg", "small");

    var entry = await buildEntry(this.blog, path);

    expect(entry.html).toMatch(
      new RegExp('srcset="' + tokenRegex("/my%20pic\\.jpg 2x").source + ', /gone%20pic\\.jpg 1x"')
    );
    expect(entry.html).not.toContain("v-deadbeef");
    expect(entry.dependencies).toContain("/my pic.jpg");
    expect(entry.dependencies).toContain("/gone pic.jpg");
  });
  describe("entry metadata", function () {
    it("is left as written, so templates can build URLs from it", async function () {
      await folder.write(this.blog.id, "/cover.jpg", "cover");
      await folder.write(this.blog.id, "/Hello.txt", "Image: /cover.jpg\n\nBody");

      var entry = await buildEntry(this.blog, "/Hello.txt");

      expect(entry.metadata.Image).toEqual("/cover.jpg");
    });
  });
});
