const sharp = require("sharp");
const { SHAPES, normalizeShape, applyShape } = require("../image-mask");

describe("profile photo shapes", function () {
  it("defaults to square and rejects unknown shapes", function () {
    expect(normalizeShape(undefined)).toBe("square");
    expect(normalizeShape("")).toBe("square");
    expect(() => normalizeShape("star")).toThrowError(/supported photo shape/);
  });

  it("clears the corners of a circle but keeps its center", async function () {
    const data = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#f00" } }).png().toBuffer();
    const { data: pixels, info } = await applyShape(data, 40, 40, "circle").raw().toBuffer({ resolveWithObject: true });
    const alpha = (x, y) => pixels[(y * info.width + x) * info.channels + 3];
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(20, 20)).toBe(255);
  });

  it("leaves every shape renderable", async function () {
    const data = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#00f" } }).png().toBuffer();
    for (const { value } of SHAPES) await applyShape(data, 32, 32, value).png().toBuffer();
  });
});
