const img = require("../index");
const fs = require("fs-extra");
const folder = require("storage/folder");
const path = require("path");
const hash = require("helper/hash");
const assets = require("storage/assets");
const s3 = require("storage/s3");

describe("img converter", function () {
  global.test.blog();

  // Resolves to [err, html, stat, extras]
  async function readAll(blog, path) {
    try {
      return [null, ...(await img.read(blog, path))];
    } catch (err) {
      return [err];
    }
  }

  const tests = fs.readdirSync(__dirname).filter((i) => img.is(i));

  tests.forEach((name) => {
    it("converts img with " + name, async function () {
      const test = this;
      const relativePath = "/" + name;
      const expected = fs.readFileSync(
        __dirname + relativePath + ".html",
        "utf8"
      );

      await folder.writeFrom(
        test.blog.id,
        relativePath,
        __dirname + relativePath
      );

      const [err, result] = await readAll(test.blog, relativePath);
      if (err) throw err;
      expect(result).toEqual(expected);
    });
  });

  it("asks the bucket about a converted image once, not on every build", async function () {
    const test = this;
    const path = "/laptop.tiff";

    await folder.writeFrom(test.blog.id, path, __dirname + path);
    await img.read(test.blog, path);

    const key = test.blog.id + "/_assets/" + hash(path) + "/";
    spyOn(s3, "head").and.callThrough();

    await img.read(test.blog, path);

    const asked = s3.head.calls
      .allArgs()
      .filter(([k]) => typeof k === "string" && k.startsWith(key));
    expect(asked).toEqual([]);
  });

  it("extracts EXIF data by default", async function () {
    const test = this;
    const path = "/exif.jpg";

    await folder.writeFrom(test.blog.id, path, __dirname + path);

    const [err, , , extras] = await readAll(test.blog, path);
    if (err) throw err;
    expect(extras).toEqual({
      exif: {
        Make: "SONY",
        Model: "ILCE-7M2",
        ExposureTime: "1/250",
        FNumber: 4.5,
        ISO: 100,
        Flash: "Off, Did not fire",
        FocalLength: 55,
        LensModel: "FE 55mm F1.8 ZA",
      },
    });
  });

  it("omits EXIF data when disabled", async function () {
    const test = this;
    const path = "/exif.jpg";

    await folder.writeFrom(test.blog.id, path, __dirname + path);
    test.blog.imageExif = "off";

    const [err, , , extras] = await readAll(test.blog, path);
    if (err) throw err;
    expect(extras).toBeUndefined();
  });

  it("returns sanitized EXIF data in basic mode", async function () {
    const test = this;
    const path = "/gps.jpg";

    await folder.writeFrom(test.blog.id, path, __dirname + path);

    test.blog.imageExif = "basic";

    const [err, , , extras] = await readAll(test.blog, path);
    if (err) throw err;

    expect(extras).toEqual({
      exif: {
        ImageDescription: "                               ",
        Make: "NIKON",
        Model: "COOLPIX P6000",
        ExposureTime: "1/178",
        FNumber: 4.5,
        ISO: 64,
        FocalLength: 6,
        Flash: "Off, Did not fire",
      },
    });
  });

  it("returns full EXIF data in full mode", async function () {
    const test = this;
    const path = "/gps.jpg";

    await folder.writeFrom(test.blog.id, path, __dirname + path);
    test.blog.imageExif = "full";

    const [err, , , extras] = await readAll(test.blog, path);
    if (err) throw err;

    expect(extras).toEqual({
      exif: {
        ImageDescription: "                               ",
        Make: "NIKON",
        Model: "COOLPIX P6000",
        ExposureTime: "1/178",
        FNumber: 4.5,
        ISO: 64,
        FocalLength: 6,
        GPSLatitude: `43 deg 28' 1.76" N`,
        GPSLongitude: `11 deg 53' 7.42" E`,
        GPSPosition: `43 deg 28' 1.76" N, 11 deg 53' 7.42" E`,
        Flash: "Off, Did not fire",
      },
    });
  });

  it("renders ImageDescription as inline Markdown", async function () {
    const test = this;
    const path = "/described.jpg";

    await folder.writeFrom(
      test.blog.id,
      path,
      __dirname + "/descriptions/described.jpg"
    );

    const [err, , , extras] = await readAll(test.blog, path);
    if (err) throw err;

    expect(extras).toEqual({
      exif: {
        ImageDescription:
          'Sunset at <strong>Point Reyes</strong>, by <a href="https://ann.example">Ann</a><br>IMG_2041_final_v2',
      },
    });
  });

  it("reuses cached conversions on repeat builds", async function () {
    const test = this;
    const relativePath = "/land.avif";
    const read = async (...args) => (await img.read(...args))[0];

    await folder.writeFrom(
      test.blog.id,
      relativePath,
      __dirname + relativePath
    );

    const firstResult = await read(test.blog, relativePath);

    expect(
      await assets.exists(
        test.blog.id,
        `_assets/${hash(relativePath)}/${path.basename(relativePath)}.png`
      )
    ).toBe(true);

    // The conversion is only written when there isn't one already
    spyOn(assets, "commit").and.callThrough();

    const secondResult = await read(test.blog, relativePath);

    expect(secondResult).toEqual(firstResult);
    expect(assets.commit).not.toHaveBeenCalled();
  });

  it("reads the EXIF of an image it converts in the same job", async function () {
    const test = this;
    const sandbox = require("sandbox");
    const relativePath = "/car.heic";

    await folder.writeFrom(
      test.blog.id,
      relativePath,
      __dirname + relativePath
    );

    spyOn(sandbox, "run").and.callThrough();
    const jobs = () => sandbox.run.calls.allArgs().map((args) => args[0]);

    const [, , first] = await img.read(test.blog, relativePath);

    expect(jobs()).toEqual(["to-png"]);
    expect(sandbox.run.calls.argsFor(0)[1].exif).toContain("Make");

    // The conversion is cached now, so only the EXIF is read, on its own
    sandbox.run.calls.reset();

    const [, , second] = await img.read(test.blog, relativePath);

    expect(jobs()).toEqual(["exif"]);
    expect(second).toEqual(first);
  });

  it("reads the EXIF of an image it does not convert with the exif job", async function () {
    const test = this;
    const sandbox = require("sandbox");

    await folder.writeFrom(test.blog.id, "/exif.jpg", __dirname + "/exif.jpg");

    spyOn(sandbox, "run").and.callThrough();

    await img.read(test.blog, "/exif.jpg");

    expect(sandbox.run.calls.allArgs().map((args) => args[0])).toEqual([
      "exif",
    ]);
  });

  it("converts a copy of a cached image into its own directory, whatever became of the first", async function () {
    const test = this;
    const firstPath = "/land.avif";
    const secondPath = "/land-copy.avif";
    const read = async (...args) => (await img.read(...args))[0];

    await folder.writeFrom(test.blog.id, firstPath, __dirname + firstPath);

    await read(test.blog, firstPath);

    const firstAssetPath = `_assets/${hash(firstPath)}/${path.basename(firstPath)}.png`;

    await assets.remove(test.blog.id, firstAssetPath);

    await folder.writeFrom(test.blog.id, secondPath, __dirname + firstPath);

    const result = await read(test.blog, secondPath);
    const secondAssetPath = `_assets/${hash(secondPath)}/${path.basename(secondPath)}.png`;

    expect(result).toContain(`src="${encodeURI("/" + secondAssetPath)}"`);
    expect(await assets.exists(test.blog.id, secondAssetPath)).toBe(true);
    expect(await assets.exists(test.blog.id, firstAssetPath)).toBe(false);
  });

  it("returns an error if the image does not exist", async function () {
    const test = this;
    const path = "/test.png";

    let error;

    try {
      await img.read(test.blog, path);
    } catch (err) {
      error = err;
    }

    expect(error).toBeTruthy();
  });

  it("gives each path its own _assets directory, even for identical bytes", async function () {
    const test = this;
    const first = "/first.tiff";
    const second = "/copies/second.tiff";

    await folder.writeFrom(test.blog.id, first, __dirname + "/laptop.tiff");
    await folder.writeFrom(test.blog.id, second, __dirname + "/laptop.tiff");

    const [err1, html1] = await readAll(test.blog, first);
    if (err1) throw err1;
    const [err2, html2] = await readAll(test.blog, second);
    if (err2) throw err2;

    expect(html1).toContain("/_assets/" + hash(first) + "/first.tiff.png");
    expect(html2).toContain("/_assets/" + hash(second) + "/second.tiff.png");

    // removing the first path's directory leaves the second's working
    await assets.remove(test.blog.id, "_assets/" + hash(first));

    expect(
      await assets.exists(
        test.blog.id,
        "_assets/" + hash(second) + "/second.tiff.png"
      )
    ).toBe(true);
    expect(
      await assets.exists(
        test.blog.id,
        "_assets/" + hash(first) + "/first.tiff.png"
      )
    ).toBe(false);

    // and the first is made again, not linked from the second's
    const [err3, html3] = await readAll(test.blog, first);
    if (err3) throw err3;
    expect(html3).toContain("/_assets/" + hash(first) + "/first.tiff.png");
    expect(
      await assets.exists(
        test.blog.id,
        "_assets/" + hash(first) + "/first.tiff.png"
      )
    ).toBe(true);
  });
});
