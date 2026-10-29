const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { SHAPES, CLIP_PATHS, normalizeShape, applyShape } = require("../image-mask");

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

  it("has no hexagon, and offers organic blobs", function () {
    const values = SHAPES.map((shape) => shape.value);
    expect(values).not.toContain("hexagon");
    expect(values).toEqual(jasmine.arrayContaining(["blob", "pebble", "cloud"]));
  });

  it("keeps the dashboard's --mask-* previews in step with the shapes", function () {
    const css = fs.readFileSync(path.join(__dirname, "../../../views/dashboard/template/controls/favicon.css"), "utf8");
    // Rounding can print a tiny negative as "-0.00%" on one platform and "0.00%" on another.
    const unsigned = (text) => text.replace(/-0\.00%/g, "0.00%");
    for (const [shape, clip] of Object.entries(CLIP_PATHS)) {
      expect(unsigned(css)).toContain(unsigned(`--mask-${shape}: ${clip};`));
      expect(css).toContain(`[data-profile-mask="${shape}"] { clip-path: var(--mask-${shape}); }`);
    }
    expect(css).not.toContain("--mask-hexagon");
  });
});
