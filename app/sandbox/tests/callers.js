// What each build step that uses the sandbox does when the sandbox fails (a
// timeout, no broker, a killed job): it fails the way it does for any other error
describe("callers of the sandbox when it fails", function () {
  global.test.blog();

  const fs = require("fs-extra");
  const os = require("os");
  const path = require("path");
  const sandbox = require("../");
  const folder = require("storage/folder");

  const image = path.join(
    __dirname,
    "../../build/thumbnail/tests/images/portrait.jpg"
  );
  let directory;

  beforeEach(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-callers-"));
    spyOn(sandbox, "run").and.callFake(function () {
      const err = new Error("sandbox: timeout");
      err.code = "SANDBOX_TIMEOUT";
      return Promise.reject(err);
    });
  });

  afterEach(async function () {
    await fs.remove(directory);
  });

  it("template zip upload reports a zip the sandbox could not read as a problem with the file", async function () {
    const unzipUpload = require("dashboard/site/template/save/unzip-upload");

    let problems;
    try {
      await unzipUpload(path.join(directory, "template.zip"));
    } catch (err) {
      expect(err.status).toEqual(422);
      problems = err.problems;
    }

    expect(sandbox.run.calls.argsFor(0)[0]).toEqual("unzip");
    expect(problems.length).toEqual(1);
    expect(problems[0].reason).toEqual("zip");
  });

  it("template zip upload does not blame the file when the sandbox is busy", async function () {
    const unzipUpload = require("dashboard/site/template/save/unzip-upload");
    sandbox.run.and.callFake(function () {
      const err = new Error("sandbox: busy");
      err.code = "SANDBOX_BUSY";
      return Promise.reject(err);
    });

    let thrown;
    try {
      await unzipUpload(path.join(directory, "template.zip"));
    } catch (err) {
      thrown = err;
    }

    expect(thrown.code).toEqual("SANDBOX_BUSY");
  });

  it("thumbnail transform passes the error to its callback and writes nothing", async function () {
    let thrown;
    let result;
    try {
      result = await require("build/thumbnail/transform")(image, directory);
    } catch (err) {
      thrown = err;
    }

    expect(thrown.code).toEqual("SANDBOX_TIMEOUT");
    expect(result).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("thumbnail transform checks the candidate in the same job and writes nothing for one it refuses", async function () {
    const output = path.join(directory, "thumbnails");
    sandbox.run.and.callFake(function () {
      return Promise.resolve({
        meta: {
          source: { format: "png", width: 10, height: 300 },
          thumbnails: null,
        },
        outputs: [],
      });
    });
    let thrown;
    let result;
    try {
      result = await require("build/thumbnail/transform")(image, output);
    } catch (err) {
      thrown = err;
    }

    expect(thrown.message).toEqual("Image (10px wide) is too small");
    expect(thrown.invalid).toBe(true);
    expect(result).toBeUndefined();
    expect(fs.existsSync(output)).toBe(false);
    expect(sandbox.run.calls.count()).toEqual(1);
    expect(sandbox.run.calls.argsFor(0)[0]).toEqual("thumbnail");
    expect(sandbox.run.calls.argsFor(0)[1].accept).toEqual({
      formats: ["png", "jpeg", "jpg", "svg", "gif", "webp"],
      minWidth: 64,
      minHeight: 64,
    });
  });

  it("animated thumbnail transform passes the error to its callback and writes nothing", async function () {
    let thrown;
    let result;
    try {
      result = await require("build/thumbnail/transform-gif")(image, directory);
    } catch (err) {
      thrown = err;
    }

    expect(thrown.code).toEqual("SANDBOX_TIMEOUT");
    expect(result).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(sandbox.run.calls.argsFor(0)[1].animated).toBe(true);
  });

  it("image resize rejects with the error and leaves the image alone", async function () {
    const file = path.join(directory, "image.jpg");
    fs.copySync(image, file);
    const before = fs.readFileSync(file);

    let err, info;
    try {
      info = await require("build/plugins/image/resize")(file);
    } catch (e) {
      err = e;
    }
    expect(err.code).toEqual("SANDBOX_TIMEOUT");
    expect(info).toBeUndefined();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("exif is empty, as it is when exiftool fails", async function () {
    const exif = require("build/converters/img/exif");
    expect(await exif.parseExif(image, "full")).toEqual({});
    expect(sandbox.run.calls.argsFor(0)[0]).toEqual("exif");
  });

  it("img converter fails to convert, as it does when sharp fails", function (done) {
    const test = this;
    const img = require("build/converters/img");
    const source = path.join(
      __dirname,
      "../../build/converters/img/tests/car.heic"
    );

    folder.writeFrom(test.blog.id, "/car.heic", source).then(function () {
      img.read(test.blog, "/car.heic").then(
        function () {
          done.fail(new Error("Expected the read to be rejected"));
        },
        function (err) {
          expect(err).toBeTruthy();
          expect(sandbox.run.calls.allArgs().map((a) => a[0])).toContain(
            "to-png"
          );
          done();
        }
      );
    }, done.fail);
  });

  it("img converter still reads an image that needs no conversion", function (done) {
    const test = this;
    const img = require("build/converters/img");
    const source = path.join(
      __dirname,
      "../../build/converters/img/tests/bunny.png"
    );

    folder.writeFrom(test.blog.id, "/bunny.png", source).then(function () {
      img.read(test.blog, "/bunny.png").then(function ([html]) {
        expect(html).toContain("/bunny.png");
        done();
      }, done.fail);
    }, done.fail);
  });

  it("docx converter fails to convert and writes no media", function (done) {
    const test = this;
    const docx = require("build/converters/docx");
    const source = path.join(
      __dirname,
      "../../build/converters/docx/tests/image.docx"
    );

    folder.writeFrom(test.blog.id, "/image.docx", source).then(function () {
      docx.read(test.blog, "/image.docx").then(
        function () {
          done.fail(new Error("Expected the read to be rejected"));
        },
        function (err) {
          // a pandoc worker that times out is the document's failure, as
          // pandoc's own timeout is (build/converters/pandoc.js)
          expect(err.message).toMatch(/^Pandoc exited .*\(timed out\)/);
          expect(sandbox.run.calls.argsFor(0)[0]).toEqual("pandoc");
          done();
        }
      );
    }, done.fail);
  });

  it("markdown converter fails to convert", function (done) {
    const test = this;
    const markdown = require("build/converters/markdown");

    folder.write(test.blog.id, "/post.md", "# Hello").then(function () {
      markdown.read(test.blog, "/post.md").then(
        function () {
          done.fail(new Error("Expected the read to be rejected"));
        },
        function (err) {
          expect(err.message).toMatch(/^Pandoc exited .*\(timed out\)/);
          expect(sandbox.run.calls.argsFor(0)[1].from).toEqual("markdown");
          done();
        }
      );
    }, done.fail);
  });
});
