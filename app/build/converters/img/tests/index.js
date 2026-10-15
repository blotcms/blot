const img = require("../index");
const fs = require("fs-extra");
const exif = require("../exif");
const path = require("path");
const hash = require("helper/hash");
const assets = require("storage/assets");
const { promisify } = require("util");

describe("img converter", function () {
  global.test.blog();

  const tests = fs.readdirSync(__dirname).filter((i) => img.is(i));

  tests.forEach((name) => {
    it("converts img with " + name, function (done) {
      const test = this;
      const relativePath = "/" + name;
      const expected = fs.readFileSync(
        __dirname + relativePath + ".html",
        "utf8"
      );

      fs.copySync(__dirname + relativePath, test.blogDirectory + relativePath);

      img.read(test.blog, relativePath, function (err, result) {
        if (err) return done.fail(err);
        expect(result).toEqual(expected);
        done();
      });
    });
  });

  it("extracts EXIF data by default", function (done) {
    const test = this;
    const path = "/exif.jpg";

    fs.copySync(__dirname + path, test.blogDirectory + path);

    img.read(test.blog, path, function (err, html, stat, extras) {
      if (err) return done.fail(err);
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
      done();
    });
  });

  it("omits EXIF data when disabled", function (done) {
    const test = this;
    const path = "/exif.jpg";

    fs.copySync(__dirname + path, test.blogDirectory + path);
    test.blog.imageExif = "off";

    img.read(test.blog, path, function (err, html, stat, extras) {
      if (err) return done.fail(err);
      expect(extras).toBeUndefined();
      done();
    });
  });

  it("returns sanitized EXIF data in basic mode", function (done) {
    const test = this;
    const path = "/gps.jpg";

    fs.copySync(__dirname + path, test.blogDirectory + path);

    test.blog.imageExif = "basic";

    img.read(test.blog, path, function (err, html, stat, extras) {
      if (err) return done.fail(err);

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
      done();
    });
  });

  it("returns full EXIF data in full mode", function (done) {
    const test = this;
    const path = "/gps.jpg";

    fs.copySync(__dirname + path, test.blogDirectory + path);
    test.blog.imageExif = "full";

    img.read(test.blog, path, function (err, html, stat, extras) {
      if (err) return done.fail(err);

      expect(extras).toEqual({
        exif: {
          ImageDescription: "                               ",
          Make: "NIKON",
          Model: "COOLPIX P6000",
          ExposureTime: "1/178",
          FNumber: 4.5,
          ISO: 64,
          Flash: "Off, Did not fire",
          FocalLength: 6,
          GPSLatitude: `43 deg 28' 1.76" N`,
          GPSLongitude: `11 deg 53' 7.42" E`,
          GPSPosition: `43 deg 28' 1.76" N, 11 deg 53' 7.42" E`,
          Flash: "Off, Did not fire",
        },
      });
      done();
    });
  });

  it("reuses cached conversions on repeat builds", async function () {
    const test = this;
    const relativePath = "/land.avif";
    const read = promisify(img.read);

    fs.copySync(__dirname + relativePath, test.blogDirectory + relativePath);

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

  it("restores missing cached conversions using cached path", async function () {
    const test = this;
    const firstPath = "/land.avif";
    const secondPath = "/land-copy.avif";
    const read = promisify(img.read);

    fs.copySync(__dirname + firstPath, test.blogDirectory + firstPath);

    await read(test.blog, firstPath);

    const cachedAssetPath = `_assets/${hash(firstPath)}/${path.basename(firstPath)}.png`;

    expect(await assets.exists(test.blog.id, cachedAssetPath)).toBe(true);

    await assets.remove(test.blog.id, cachedAssetPath);

    const fallbackAssetPath = `_assets/${hash(secondPath)}/${path.basename(secondPath)}.png`;

    await assets.remove(test.blog.id, fallbackAssetPath);

    fs.copySync(__dirname + firstPath, test.blogDirectory + secondPath);

    const result = await read(test.blog, secondPath);

    const expectedSrc = encodeURI(
      `/_assets/${hash(firstPath)}/${path.basename(firstPath)}.png`
    );

    expect(result).toContain(`src="${expectedSrc}"`);
    expect(await assets.exists(test.blog.id, cachedAssetPath)).toBe(true);
    expect(await assets.exists(test.blog.id, fallbackAssetPath)).toBe(false);
  });

  it("returns an error if the image does not exist", function (done) {
    const test = this;
    const path = "/test.png";

    img.read(test.blog, path, function (err) {
      expect(err).toBeTruthy();
      done();
    });
  });
});
