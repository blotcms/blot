describe("template image thumbnails", function () {
  global.test.blog();
  global.test.tmp();

  const fs = require("fs-extra");
  const { join } = require("path");
  const sharp = require("sharp");
  const { generate, parseCrop } = require("../template-image");

  async function source(directory, width = 320, height = 180) {
    const path = join(directory, `source-${width}-${height}.png`);
    await sharp({
      create: { width, height, channels: 4, background: "#2468ac" },
    }).png().toFile(path);
    return path;
  }

  it("creates proportional derivatives without enlarging the source", async function () {
    const input = await source(this.tmp, 320, 180);
    const output = join(this.tmp, "output");
    const result = await generate(input, output, {});

    expect(result.original.width).toBe(320);
    expect(result.original.height).toBe(180);
    expect(result.thumbnails.small.width).toBe(160);
    expect(result.thumbnails.small.height).toBe(90);
    expect(result.thumbnails.medium.width).toBe(320);
    expect(result.thumbnails.large.width).toBe(320);
    expect(result.thumbnails.square.width).toBe(160);
    expect(result.thumbnails.square.height).toBe(160);

    for (const item of [result.original, ...Object.values(result.thumbnails)]) {
      expect(await fs.pathExists(join(output, item.name))).toBe(true);
    }
  });

  it("validates normalized rectangular crop coordinates", function () {
    expect(parseCrop({ x: "0.25", y: "0.1", width: "0.5", height: "0.4" }, 400, 200)).toEqual({
      left: 100, top: 20, width: 200, height: 80,
    });
    expect(() => parseCrop({ x: "0.9", y: "0", width: "0.5", height: "0.5" }, 400, 200)).toThrowError(/invalid/);
  });

  describe("editable images", function () {
    const { generate, regenerate, SOURCE_MAX } = require("../template-image");

    // Left 1000px red, the rest blue, so the crop is easy to see in a pixel
    async function wide(path) {
      await sharp({ create: { width: 3200, height: 1800, channels: 3, background: "#3366cc" } })
        .composite([{ input: Buffer.from('<svg width="1000" height="1800"><rect width="1000" height="1800" fill="#cc3333"/></svg>') }])
        .png().toFile(path);
    }
    const center = async (file) => {
      const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
      const at = ((info.height >> 1) * info.width + (info.width >> 1)) * info.channels;
      return { red: data[at] > 128, size: [info.width, info.height] };
    };

    it("stores the whole image shrunk to the source size and keeps the crop", async function () {
      const source = join(this.tmp, "wide.png");
      await wide(source);

      const made = await generate(source, join(this.tmp, "out"), { x: "0.4375", y: "0", width: "0.5625", height: "1" }, { editable: true });

      expect(Math.max(made.original.width, made.original.height)).toBe(SOURCE_MAX);
      expect(made.original.width / made.original.height).toBeCloseTo(3200 / 1800, 2);
      expect(made.crop).toEqual({ x: 0.4375, y: 0, width: 0.5625, height: 1 });
      expect((await center(join(this.tmp, "out", made.thumbnails.large.name))).red).toBe(false);
      // the original still holds the red part that was cropped away
      const stored = await sharp(join(this.tmp, "out", made.original.name)).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
      expect(stored[0]).toBeGreaterThan(128);
    });

    it("never enlarges a small source", async function () {
      const source = join(this.tmp, "small.png");
      await sharp({ create: { width: 300, height: 200, channels: 3, background: "#369" } }).png().toFile(source);
      const made = await generate(source, join(this.tmp, "out"), {}, { editable: true });
      expect([made.original.width, made.original.height]).toEqual([300, 200]);
      expect(made.crop).toBeNull();
    });

    it("re-crops from the stored source without a new upload", async function () {
      const source = join(this.tmp, "wide.png");
      await wide(source);
      const made = await generate(source, join(this.tmp, "out"), { x: "0.4375", y: "0", width: "0.5625", height: "1" }, { editable: true });

      const again = await regenerate(await fs.readFile(join(this.tmp, "out", made.original.name)), join(this.tmp, "out"), { x: 0, y: 0, width: 0.3, height: 0.5333 }, "circle");

      expect((await center(join(this.tmp, "out", again.thumbnails.large.name))).red).toBe(true);
      expect(again.thumbnails.large.name).not.toBe(made.thumbnails.large.name);
    });
  });

  it("removes already-published derivatives when publication fails", async function () {
    const input = await source(this.tmp);
    const output = join(this.tmp, "rollback");
    const realMove = fs.move;
    let moves = 0;
    spyOn(fs, "move").and.callFake(function (from, to, options) {
      moves += 1;
      if (moves === 3) return Promise.reject(new Error("move failed"));
      return realMove(from, to, options);
    });

    await expectAsync(generate(input, output, {})).toBeRejectedWith(new Error("move failed"));
    expect(await fs.readdir(output)).toEqual([]);
  });
});
