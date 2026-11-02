// What each build step that uses the sandbox does when the sandbox fails (a
// timeout, no broker, a killed job): it fails the way it does for any other error
describe("callers of the sandbox when it fails", function () {
  global.test.blog();

  const fs = require("fs-extra");
  const os = require("os");
  const path = require("path");
  const sandbox = require("../");

  const image = path.join(__dirname, "../../build/thumbnail/tests/images/portrait.jpg");
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

  it("thumbnail validate passes the error to its callback", function (done) {
    require("build/thumbnail/validate")(image, function (err) {
      expect(err.code).toEqual("SANDBOX_TIMEOUT");
      expect(sandbox.run.calls.argsFor(0)[0]).toEqual("metadata");
      done();
    });
  });

  it("thumbnail transform passes the error to its callback and writes nothing", function (done) {
    require("build/thumbnail/transform")(image, directory, function (err, result) {
      expect(err.code).toEqual("SANDBOX_TIMEOUT");
      expect(result).toBeUndefined();
      expect(fs.readdirSync(directory)).toEqual([]);
      done();
    });
  });

  it("animated thumbnail transform passes the error to its callback and writes nothing", function (done) {
    require("build/thumbnail/transform-gif")(image, directory, function (err, result) {
      expect(err.code).toEqual("SANDBOX_TIMEOUT");
      expect(result).toBeUndefined();
      expect(fs.readdirSync(directory)).toEqual([]);
      expect(sandbox.run.calls.argsFor(0)[1].animated).toBe(true);
      done();
    });
  });

  it("image resize passes the error to its callback and leaves the image alone", function (done) {
    const file = path.join(directory, "image.jpg");
    fs.copySync(image, file);
    const before = fs.readFileSync(file);

    require("build/plugins/image/resize")(file, function (err, info) {
      expect(err.code).toEqual("SANDBOX_TIMEOUT");
      expect(info).toBeUndefined();
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      done();
    });
  });

  it("exif is empty, as it is when exiftool fails", async function () {
    const exif = require("build/converters/img/exif");
    expect(await exif.parseExif(image, "full")).toEqual({});
    expect(sandbox.run.calls.argsFor(0)[0]).toEqual("exif");
  });

  it("img converter fails to convert, as it does when sharp fails", function (done) {
    const test = this;
    const img = require("build/converters/img");
    const source = path.join(__dirname, "../../build/converters/img/tests/car.heic");
    fs.copySync(source, test.blogDirectory + "/car.heic");

    img.read(test.blog, "/car.heic", function (err) {
      expect(err).toBeTruthy();
      expect(sandbox.run.calls.allArgs().map((a) => a[0])).toContain("to-png");
      done();
    });
  });

  it("img converter still reads an image that needs no conversion", function (done) {
    const test = this;
    const img = require("build/converters/img");
    const source = path.join(__dirname, "../../build/converters/img/tests/bunny.png");
    fs.copySync(source, test.blogDirectory + "/bunny.png");

    img.read(test.blog, "/bunny.png", function (err, html) {
      expect(err).toBe(null);
      expect(html).toContain("/bunny.png");
      done();
    });
  });

  it("docx converter fails to convert and writes no media", function (done) {
    const test = this;
    const docx = require("build/converters/docx");
    const source = path.join(__dirname, "../../build/converters/docx/tests/image.docx");
    fs.copySync(source, test.blogDirectory + "/image.docx");

    docx.read(test.blog, "/image.docx", function (err, html) {
      expect(err.code).toEqual("SANDBOX_TIMEOUT");
      expect(html).toBeUndefined();
      expect(sandbox.run.calls.argsFor(0)[0]).toEqual("pandoc");
      done();
    });
  });

  it("markdown converter fails to convert", function (done) {
    const test = this;
    const markdown = require("build/converters/markdown");
    fs.outputFileSync(test.blogDirectory + "/post.md", "# Hello");

    markdown.read(test.blog, "/post.md", function (err, html) {
      expect(err.code).toEqual("SANDBOX_TIMEOUT");
      expect(html).toBeUndefined();
      expect(sandbox.run.calls.argsFor(0)[1].from).toEqual("markdown");
      done();
    });
  });
});
