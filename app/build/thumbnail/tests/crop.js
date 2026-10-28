const { parseCrop } = require("../crop");

describe("normalized crop parsing", function () {
  it("treats blank coordinates as no crop", function () {
    expect(parseCrop({ x: "", y: "", width: "", height: "" }, 400, 200)).toBeNull();
    expect(parseCrop({ x: "0.1", y: "0.1" }, 400, 200)).toBeNull();
    expect(parseCrop(undefined, 400, 200)).toBeNull();
  });

  it("converts rectangles and squares to pixels", function () {
    expect(parseCrop({ x: "0.25", y: "0.1", width: "0.5", height: "0.4" }, 400, 200)).toEqual({ left: 100, top: 20, width: 200, height: 80 });
    expect(parseCrop({ x: "0.25", y: "0", size: "0.5" }, 400, 200)).toEqual({ left: 100, top: 0, width: 100, height: 100 });
  });

  it("tolerates float overshoot at the right and bottom edges", function () {
    const x = (400 - 123) / 400;
    const width = 123 / 400;
    expect(x + width).toBeGreaterThan(1 - 1e-9);
    expect(parseCrop({ x: String(x + 1e-12), y: "0", width: String(width), height: "1" }, 400, 200)).toEqual({ left: 277, top: 0, width: 123, height: 200 });
  });

  it("rejects crops that leave the image", function () {
    expect(() => parseCrop({ x: "0.9", y: "0", width: "0.5", height: "0.5" }, 400, 200)).toThrowError(/invalid/);
    expect(() => parseCrop({ x: "0.8", y: "0", size: "1" }, 100, 50, "favicon")).toThrowError(/outside/);
    expect(() => parseCrop({ x: "0", y: "0", width: "0", height: "1" }, 100, 50)).toThrowError(/invalid/);
  });
});
