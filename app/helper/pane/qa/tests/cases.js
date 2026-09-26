// The registry is derived by scanning reference/, so it should list every
// screenshot with a stable id.

const { loadCases, getCase } = require("../lib/cases");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("pane qa cases", function () {
  it("derives an id per reference image", function () {
    const cases = loadCases();
    const ids = cases.map((c) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    const c = getCase("macos-dark-icons", cases);
    expect(c).toBeTruthy();
    expect(c.os).toBe("macos");
    expect(c.theme).toBe("dark");
    expect(c.view).toBe("icons");
    expect(c.scale).toBe(2);
    expect(c.file).toBe("macos-dark@2x-icons.png");
    expect(c.logicalSize.width * c.scale).toBe(c.imageSize.width);
    expect(c.renderedPath.endsWith(path.join("rendered", "macos", "macos-dark@2x-icons.png"))).toBe(true);
    expect(getCase("macos-dark", cases).view).toBe("default");
  });

  it("masks the date column of views that show dates", function () {
    const cases = loadCases();
    expect(getCase("macos-light", cases).masks.length).toBe(1);
    expect(getCase("macos-light-icons", cases).masks.map((m) => m.kind)).not.toContain("time"); // no dates in the icons view
    expect(getCase("windows-light-icons", cases).masks.length).toBe(0);
  });

  it("picks up new screenshots automatically", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pane-qa-"));
    try {
      fs.mkdirSync(path.join(dir, "linux"));
      // a minimal PNG header is enough: only the size is read
      const png = Buffer.alloc(33);
      Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png);
      png.writeUInt32BE(200, 16);
      png.writeUInt32BE(100, 20);
      fs.writeFileSync(path.join(dir, "linux", "linux-dark@2x-newview.png"), png);
      fs.writeFileSync(path.join(dir, "linux", "notes.txt"), "ignored");
      const cases = loadCases(dir);
      expect(cases.map((c) => c.id)).toEqual(["linux-dark-newview"]);
      expect(cases[0].imageSize).toEqual({ width: 200, height: 100 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
