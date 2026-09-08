describe("favicon assets", function () {
  global.test.blog();
  global.test.tmp();

  const fs = require("fs-extra");
  const { join } = require("path");
  const sharp = require("sharp");
  const { generate, cropFor } = require("../save/favicon-assets");

  it("uses a centered square crop when no crop is supplied", function () {
    expect(cropFor({ width: 800, height: 400 })).toEqual({
      left: 200,
      top: 0,
      width: 400,
      height: 400,
    });
  });

  it("rejects crops outside the uploaded image", function () {
    expect(() => cropFor({ width: 100, height: 50 }, { x: 0.8, y: 0, size: 1 })).toThrowError(/outside/);
  });

  it("creates a multi-size ico and PNG derivatives from the selected crop", async function () {
    const source = join(this.tmp, "source.png");
    const destination = join(this.tmp, "output");
    await sharp({ create: { width: 400, height: 200, channels: 4, background: "#ff0000" } })
      .composite([{ input: { create: { width: 200, height: 200, channels: 4, background: "#0000ff" } }, left: 200, top: 0 }])
      .png()
      .toFile(source);

    const favicon = await generate(source, destination, { x: 0.5, y: 0, size: 1 });
    const icon = await fs.readFile(join(destination, `${favicon.prefix}.ico`));
    expect(icon.slice(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
    expect(icon.readUInt16LE(4)).toEqual(3);

    for (const size of [16, 32, 180]) {
      const metadata = await sharp(join(destination, `${favicon.prefix}-${size}.png`)).metadata();
      expect(metadata.width).toEqual(size);
      expect(metadata.height).toEqual(size);
    }
  });

  it("produces a well-formed ico from a 3-channel (JPEG) source", async function () {
    const source = join(this.tmp, "source.jpg");
    const destination = join(this.tmp, "output-jpg");
    await sharp({ create: { width: 120, height: 120, channels: 3, background: "#3366cc" } })
      .jpeg()
      .toFile(source);
    expect((await sharp(source).metadata()).channels).toEqual(3);

    const favicon = await generate(source, destination, { x: 0, y: 0, size: 1 });

    // to-ico@1.1.5 embeds each size as a 32-bit BITMAPINFOHEADER DIB (40-byte
    // header + width*height*4, no AND mask). If the source is not 4-channel it
    // sizes the pixel data as 24-bit, so the directory entry's declared size no
    // longer matches a 32-bit DIB. Recompute the expected size for every entry
    // and check the entries tile the file exactly.
    const ico = await fs.readFile(join(destination, `${favicon.prefix}.ico`));
    expect(ico.slice(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
    const count = ico.readUInt16LE(4);
    expect(count).toEqual(3);

    const dibSize = (side) => 40 + side * side * 4;
    let covered = 6 + count * 16;
    const sides = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const side = ico[entry] === 0 ? 256 : ico[entry];
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(ico.readUInt16LE(entry + 6)).toEqual(32); // bit depth
      expect(length).toEqual(dibSize(side));
      expect(offset).toEqual(covered);
      covered += length;
      sides.push(side);
    }
    expect(covered).toEqual(ico.length);
    expect(sides.sort((a, b) => a - b)).toEqual([16, 32, 48]);
  });
});
