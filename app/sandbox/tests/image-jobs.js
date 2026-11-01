describe("sandbox image jobs", function () {
  const sharp = require("sharp");
  const config = require("config");
  const sandbox = require("../");

  let socket;

  beforeEach(function () {
    // no broker: the jobs run in-process
    socket = config.sandbox.socket;
    config.sandbox.socket = "";
  });

  afterEach(function () {
    config.sandbox.socket = socket;
  });

  async function image(width, height, format) {
    return sharp({
      create: { width, height, channels: 3, background: "#369" },
    })
      .toFormat(format || "png")
      .toBuffer();
  }

  async function rejection(promise) {
    try {
      await promise;
    } catch (e) {
      return e;
    }
    return null;
  }

  describe("thumbnail", function () {
    const valid = {
      extension: ".jpg",
      animated: false,
      sizes: [{ size: 160, crop: false }],
    };

    it("makes one output per size, in order, never enlarging", async function () {
      const input = await image(400, 200);
      const { meta, outputs } = await sandbox.run(
        "thumbnail",
        {
          extension: ".png",
          animated: false,
          sizes: [
            { size: 100, crop: false },
            { size: 100, crop: true },
            { size: 1000, crop: false },
          ],
        },
        input
      );

      expect(meta).toEqual([
        { width: 100, height: 50, format: "png" },
        { width: 100, height: 100, format: "png" },
        { width: 400, height: 200, format: "png" },
      ]);
      expect(outputs.length).toEqual(3);
      expect((await sharp(outputs[1]).metadata()).format).toEqual("png");
    });

    it("encodes in the format of the extension", async function () {
      const { meta, outputs } = await sandbox.run("thumbnail", valid, await image(400, 200));
      expect(meta[0].format).toEqual("jpeg");
      expect((await sharp(outputs[0]).metadata()).format).toEqual("jpeg");
    });

    it("takes the format from the extension, not the input", async function () {
      const input = await sharp({
        create: { width: 400, height: 200, channels: 3, background: "#808080" },
      })
        .png()
        .toBuffer();
      const { meta } = await sandbox.run("thumbnail", valid, input);
      expect(meta[0].format).toEqual("jpeg");
    });

    it("keeps the input's format for an extension sharp doesn't know", async function () {
      const input = await sharp({
        create: { width: 400, height: 200, channels: 3, background: "#808080" },
      })
        .png()
        .toBuffer();
      const { meta } = await sandbox.run("thumbnail", { ...valid, extension: ".xyz" }, input);
      expect(meta[0].format).toEqual("png");
    });

    it("handles animated images", async function () {
      const { meta } = await sandbox.run(
        "thumbnail",
        { extension: ".gif", animated: true, sizes: [{ size: 50, crop: true }] },
        require("fs").readFileSync(__dirname + "/../../build/plugins/image/tests-image.gif")
      );
      expect(meta[0].format).toEqual("gif");
      expect(meta[0].width).toBeLessThanOrEqual(50);
    });

    it("rejects arguments it does not expect", async function () {
      const input = await image(10, 10);
      const bad = [
        undefined,
        null,
        "sizes",
        {},
        { ...valid, extension: "/../x" },
        { ...valid, extension: "__proto__" },
        { ...valid, extension: undefined },
        { ...valid, animated: "yes" },
        { ...valid, sizes: [] },
        { ...valid, sizes: "160" },
        { ...valid, sizes: new Array(17).fill({ size: 10, crop: false }) },
        { ...valid, sizes: [null] },
        { ...valid, sizes: [{ size: 0, crop: false }] },
        { ...valid, sizes: [{ size: 8193, crop: false }] },
        { ...valid, sizes: [{ size: 1.5, crop: false }] },
        { ...valid, sizes: [{ size: "160", crop: false }] },
        { ...valid, sizes: [{ size: 160 }] },
        { ...valid, sizes: [{ size: 160, crop: "true" }] },
      ];
      for (const args of bad) {
        expect(await rejection(sandbox.run("thumbnail", args, input))).not.toBeNull();
      }
    });
  });

  describe("resize", function () {
    it("fits the image inside max and keeps its format", async function () {
      const { meta, outputs } = await sandbox.run("resize", { max: 100 }, await image(400, 200, "jpeg"));
      expect(meta.width).toEqual(100);
      expect(meta.height).toEqual(50);
      expect(meta.format).toEqual("jpeg");
      expect(meta.size).toEqual(outputs[0].length);
      expect((await sharp(outputs[0]).metadata()).width).toEqual(100);
    });

    it("does not enlarge", async function () {
      const { meta } = await sandbox.run("resize", { max: 3000 }, await image(40, 20));
      expect(meta.width).toEqual(40);
      expect(meta.height).toEqual(20);
    });

    it("rejects a max it does not expect", async function () {
      const input = await image(10, 10);
      for (const max of [undefined, null, 0, -1, 1.5, "3000", 16385, NaN, Infinity]) {
        expect(await rejection(sandbox.run("resize", { max }, input))).not.toBeNull();
      }
      expect(await rejection(sandbox.run("resize", undefined, input))).not.toBeNull();
    });
  });

  describe("to-png", function () {
    it("converts to png", async function () {
      const { meta, outputs } = await sandbox.run("to-png", {}, await image(30, 20, "webp"));
      expect(meta).toEqual({ width: 30, height: 20 });
      expect((await sharp(outputs[0]).metadata()).format).toEqual("png");
    });

    it("rejects bytes that are not an image", async function () {
      expect(await rejection(sandbox.run("to-png", {}, Buffer.from("nope")))).not.toBeNull();
    });
  });

  describe("exif", function () {
    it("rejects fields it does not expect", async function () {
      const input = await image(10, 10);
      const bad = [
        undefined,
        {},
        { fields: "Make" },
        { fields: [] },
        { fields: [1] },
        { fields: ["Make Model"] },
        { fields: ["-all"] },
        { fields: [""] },
        { fields: new Array(65).fill("Make") },
      ];
      for (const args of bad) {
        expect(await rejection(sandbox.run("exif", args, input))).not.toBeNull();
      }
    });
  });
});
