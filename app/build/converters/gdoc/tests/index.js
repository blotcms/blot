const templates = require("templates");
const gdoc = require("../index");
const fs = require("fs-extra");
const folder = require("storage/folder");
const express = require("express");
const sharp = require("sharp");
const nock = require("nock");
const hash = require("helper/hash");

const imageBuffer = async () =>
  sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .jpeg()
    .toBuffer();

describe("gdoc converter", function () {
  global.test.blog();

  // Build the templates
  beforeAll(async function () {
    await templates({ watch: false });
  }, 10 * 1000); // longer timeout

  beforeAll(function (done) {
    const app = express();

    app.get("/image.jpg", (req, res) => {
      sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .jpeg()
        .toBuffer()
        .then((data) => {
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": data.length,
          });
          res.end(data);
        });
    });

    app.listen(7391, done);
  });

  const tests = fs
    .readdirSync(__dirname)
    .filter((i) => i.slice(-5) === ".gdoc");

  tests.forEach((name) => {
    it(`converts google doc with ${name}`, function (done) {
      const test = this;
      const path = `/${name}`;
      const expected = fs.readFileSync(`${__dirname + path}.html`, "utf8");

      let input = fs.readFileSync(__dirname + path, "utf8");

      // replace the image URLs in the input with the local test server
      // e.g. src="https://lh7-rt.googleusercontent.com/docsz/AD_4nXeOM3QajRFUH4o1uvULhy3HKKOGpPIi39yxJqyA5mUwvm9PCEz-ukcgLb0IQ_hePGn8OGUdlRrssCgWOe6-_4CNXNdjrq95OJpfoKZZWDWo3gW2ge1mdn5NzGGKL9H9pQ-pvdHEQCI?key=sopuY66csb8X0yGU9VCD5g"
      // -> src="http://localhost:7391/image.jpg"
      input = input.replace(
        /https:\/\/lh[0-9]+-rt\.googleusercontent\.com\/docsz\/[A-Za-z0-9_-]+(\?key=[A-Za-z0-9_-]+)/g,
        "http://localhost:7391/image.jpg"
      );

      folder.write(test.blog.id, path, input).then(function () {
        gdoc.read(test.blog, path, function (err, result) {
          if (err) return done.fail(err);
          expect(result).toEqual(expected);
          done();
        });
      }, done.fail);
    });
  });

  it("reuses cached transformer asset when the remote URL expires", async function () {
    const test = this;
    const path = `/image-alt-title.gdoc`;
    const input = await fs.readFile(__dirname + path, "utf8");

    const originalSrc = input.match(
      /https:\/\/lh[0-9]+-rt\.googleusercontent\.com\/docsz\/[A-Za-z0-9_-]+\?[^"']+/i
    )[0];

    const remoteUrl = new URL(originalSrc);

    const scope = nock(remoteUrl.origin)
      .get(remoteUrl.pathname)
      .query(true)
      .reply(200, await imageBuffer(), {
        "Content-Type": "image/jpeg",
        "Cache-Control": "max-age=0",
      })
      .get(remoteUrl.pathname)
      .query(true)
      .reply(404, "gone");

    await folder.write(test.blog.id, path, input);

    const readDoc = () =>
      new Promise((resolve, reject) => {
        gdoc.read(test.blog, path, function (err, result) {
          if (err) return reject(err);
          resolve(result);
        });
      });

    try {
      const expected = `<img alt="Album cover" src="/_assets/5cfb3e701e0cc48c37e89045580a3bce/0ae35d488e755ba7235e788e58e882ad.jpeg" title="Title of image">`;

      const first = await readDoc();
      expect(first).toContain(expected);

      const second = await readDoc();
      expect(second).toContain(expected);
    } finally {
      nock.cleanAll();
    }

    expect(scope.isDone()).toBe(true);
  });

  it("leaves pre-rewritten /_assets/ refs unchanged (ZIP export fast-path, no re-copy)", async function () {
    const test = this;
    const path = "/zip-style-rewritten.gdoc";
    const docHash = hash(path);
    const assetPath = `/_assets/${docHash}/photo.jpeg`;
    const minimalHtml = [
      "<html><head><meta charset='utf-8'></head><body>",
      "<p><img alt='' src='" + assetPath + "'></p>",
      "</body></html>",
    ].join("");

    await folder.write(test.blog.id, path, minimalHtml);

    const result = await new Promise((resolve, reject) => {
      gdoc.read(test.blog, path, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    expect(result).toContain(assetPath);
  });

  it("does not duplicate or re-copy images already at /_assets/...", async function () {
    const test = this;
    const path = "/pre-rewritten-assets.gdoc";
    const docHash = hash(path);
    const filename = "existing-image.jpg";
    const assetSrc = `/_assets/${docHash}/${filename}`;
    const minimalHtml = [
      "<html><head><meta charset='utf-8'></head><body>",
      "<p>Text</p><p><img src='" + assetSrc + "' alt='Already in assets'></p>",
      "</body></html>",
    ].join("");

    await folder.write(test.blog.id, path, minimalHtml);

    const result = await new Promise((resolve, reject) => {
      gdoc.read(test.blog, path, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    expect(result).toContain(assetSrc);
  });
});
