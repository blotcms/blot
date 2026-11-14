describe("sandbox ico", function () {
  const sharp = require("sharp");
  const toIco = require("sandbox/jobs/ico");

  const png = (size) =>
    sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: "#3366cc",
      },
    })
      .png()
      .toBuffer();

  it("packs each PNG after a directory that points at it", async function () {
    const pngs = [await png(16), await png(256)];
    const ico = toIco(pngs);

    expect(ico.subarray(0, 6)).toEqual(Buffer.from([0, 0, 1, 0, 2, 0]));
    let offset = 6 + 2 * 16;
    pngs.forEach((image, i) => {
      const entry = 6 + i * 16;
      expect(ico[entry]).toEqual(i === 0 ? 16 : 0); // 0 means 256
      expect(ico.readUInt32LE(entry + 8)).toEqual(image.length);
      expect(ico.readUInt32LE(entry + 12)).toEqual(offset);
      expect(ico.subarray(offset, offset + image.length)).toEqual(image);
      offset += image.length;
    });
    expect(ico.length).toEqual(offset);
  });

  it("rejects what it cannot store", async function () {
    expect(() => toIco([])).toThrow();
    expect(() => toIco([Buffer.from("not a png")])).toThrow();
    const tooBig = await png(257);
    expect(() => toIco([tooBig])).toThrow();
  });
});
