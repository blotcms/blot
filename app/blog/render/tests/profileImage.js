const fs = require("fs");
const path = require("path");
const { locals } = require("../profileImage");
const { CLIP_PATHS } = require("../../../build/thumbnail/image-mask");

describe("profile image template locals", function () {
  const thumbnails = {
    small: { url: "https://cdn/a-small.webp", width: 160, height: 160 },
    medium: { url: "https://cdn/a-medium.webp", width: 640, height: 640 },
    large: { url: "https://cdn/a-large.webp", width: 1200, height: 1200 },
    square: { url: "https://cdn/a-square.webp", width: 160, height: 160 },
  };

  it("builds a srcset from the proportional thumbnails and the mask's clip-path", function () {
    const original = { url: "https://cdn/a-original.webp", mask: "circle", thumbnails };
    const { profile_image: image } = locals({ profile_image: original });

    expect(image.srcset).toBe("https://cdn/a-small.webp 160w, https://cdn/a-medium.webp 640w, https://cdn/a-large.webp 1200w");
    expect(image.clip_path).toBe("circle(50%)");
    expect(image.thumbnails).toBe(thumbnails);
    expect(original.srcset).toBeUndefined();
  });

  it("skips thumbnails that repeat a width (small originals are never enlarged)", function () {
    const { profile_image: image } = locals({ profile_image: { thumbnails: { small: { url: "https://cdn/s.webp", width: 160, height: 160 }, medium: { url: "https://cdn/b.webp", width: 300, height: 300 }, large: { url: "https://cdn/c.webp", width: 300, height: 300 } } } });
    expect(image.srcset).toBe("https://cdn/s.webp 160w, https://cdn/b.webp 300w");
  });

  it("has no clip-path for the square shape or an unknown one", function () {
    expect(locals({ profile_image: { mask: "square", thumbnails } }).profile_image.clip_path).toBe("");
    expect(locals({ profile_image: { mask: "star", thumbnails } }).profile_image.clip_path).toBe("");
  });

  it("passes through a profile_image with no upload", function () {
    const input = { profile_image: {} };
    expect(locals(input)).toBe(input);
    expect(locals({})).toEqual({});
  });

  it("keeps the dashboard's --mask-* previews in step with the clip-paths", function () {
    const css = fs.readFileSync(path.join(__dirname, "../../../views/dashboard/template/controls/favicon.css"), "utf8");
    for (const [shape, clip] of Object.entries(CLIP_PATHS)) {
      expect(css).toContain(`--mask-${shape}: ${clip};`);
    }
  });
});
