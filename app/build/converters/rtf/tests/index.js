const fs = require("fs-extra");
const rtf = require("build/converters/rtf/index");

describe("rtf converter", function () {
  global.test.blog();
  const dir = __dirname + "/examples";

  fs.readdirSync(dir)
    .filter((file) => rtf.is(file))
    .forEach((file) => {
      it(
        "handles " + file.slice(0, -4).split("-").join(" "),
        async function () {
          // Copy the .bib and csl files to the root of the blog folder
          await test.folder.copyDirectory(this.blog.id, dir);

          const path = "/" + file;
          const [html] = await rtf.read(this.blog, path);

          {
            let expected;

            try {
              expected = fs.readFileSync(dir + path + ".html", "utf8");
            } catch (e) {}

            if (html !== expected)
              fs.outputFileSync(dir + path + ".expected.html", html);

            expect(expected).toEqual(html);
          }
        }
      );
    });
});

describe("rtf converter images", function () {
  const assets = require("storage/assets");
  const folder = require("storage/folder");
  const hash = require("helper/hash");

  global.test.blog();

  it("writes an RTF's images to the blog's assets and points at them", async function () {
    const path = "/image.rtf";
    await folder.write(
      this.blog.id,
      path,
      fs.readFileSync(__dirname + "/image.rtf")
    );

    const [html] = await rtf.read(this.blog, path);

    const sources = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(sources.length).toBe(2);
    for (const src of sources) {
      expect(src.indexOf("/_assets/" + hash(path) + "/media/")).toBe(0);
      const data = await assets.read(this.blog.id, src);
      expect(data.subarray(1, 4).toString()).toBe("PNG");
    }
  });
});
