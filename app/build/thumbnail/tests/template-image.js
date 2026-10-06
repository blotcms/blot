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

  it("validates normalized crop coordinates", function () {
    expect(parseCrop({ x: "0.25", y: "0", size: "0.5" }, 400, 200)).toEqual({
      left: 100, top: 0, width: 100, height: 100,
    });
    expect(() => parseCrop({ x: "0.9", y: "0", size: "0.5" }, 400, 200)).toThrowError(/outside/);
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
