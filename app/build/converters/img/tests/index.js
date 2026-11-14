const img = require("../index");
const fs = require("fs-extra");
const folder = require("storage/folder");
const path = require("path");
const hash = require("helper/hash");
const assets = require("storage/assets");

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

  describe("captions", function () {
    // Written with exiftool into copies of blast@2x.jpg and photo.heic
    const SUNSET = "Sunset at **Point Reyes**, by [Ann](https://ann.example)";
    const SUNSET_HTML =
      'Sunset at <strong>Point Reyes</strong>, by <a href="https://ann.example">Ann</a>';

    async function readCaptioned(test, name) {
      const path = "/" + name;
      await folder.writeFrom(
        test.blog.id,
        path,
        __dirname + "/captions/" + name
      );
      return readAll(test.blog, path);
    }

    it("renders the caption of a JPEG from Apple Photos", async function () {
      const [err, html, , extras] = await readCaptioned(this, "photos.jpg");
      if (err) throw err;

      expect(extras).toEqual({
        // The raw description, for templates which already print it
        exif: { ImageDescription: SUNSET },
        caption: SUNSET_HTML,
      });

      // alt and title stay the filename's title, never the caption
      expect(html).toEqual(
        '<img src="/photos.jpg" title="photos" alt="photos" />'
      );
    });

    it("reads a caption written only to XMP, as in HEIC exports", async function () {
      const [err, , , extras] = await readCaptioned(this, "photos.heic");
      if (err) throw err;

      expect(extras).toEqual({
        caption: "IMG_2041_final_v2<br>second line",
      });
    });

    it("reads the caption when EXIF is off", async function () {
      this.blog.imageExif = "off";

      const [err, , , extras] = await readCaptioned(this, "photos.jpg");
      if (err) throw err;

      expect(extras).toEqual({ caption: SUNSET_HTML });
    });

    it("ignores a camera's default description", async function () {
      const [err, , , extras] = await readCaptioned(this, "camera.jpg");
      if (err) throw err;

      expect(extras).toEqual({
        exif: {
          Make: "OLYMPUS",
          ImageDescription: "OLYMPUS DIGITAL CAMERA         ",
        },
      });
    });

    it("ignores a blank description", async function () {
      const path = "/gps.jpg";
      await folder.writeFrom(this.blog.id, path, __dirname + path);
      this.blog.imageExif = "off";

      const [err, , , extras] = await readAll(this.blog, path);
      if (err) throw err;
      expect(extras).toBeUndefined();
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

  it("restores missing cached conversions using cached path", async function () {
    const test = this;
    const firstPath = "/land.avif";
    const secondPath = "/land-copy.avif";
    const read = async (...args) => (await img.read(...args))[0];

    await folder.writeFrom(test.blog.id, firstPath, __dirname + firstPath);

    await read(test.blog, firstPath);

    const cachedAssetPath = `_assets/${hash(firstPath)}/${path.basename(firstPath)}.png`;

    expect(await assets.exists(test.blog.id, cachedAssetPath)).toBe(true);

    await assets.remove(test.blog.id, cachedAssetPath);

    const fallbackAssetPath = `_assets/${hash(secondPath)}/${path.basename(secondPath)}.png`;

    await assets.remove(test.blog.id, fallbackAssetPath);

    await folder.writeFrom(test.blog.id, secondPath, __dirname + firstPath);

    const result = await read(test.blog, secondPath);

    const expectedSrc = encodeURI(
      `/_assets/${hash(firstPath)}/${path.basename(firstPath)}.png`
    );

    expect(result).toContain(`src="${expectedSrc}"`);
    expect(await assets.exists(test.blog.id, cachedAssetPath)).toBe(true);
    expect(await assets.exists(test.blog.id, fallbackAssetPath)).toBe(false);
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
});
