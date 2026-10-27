const fs = require("fs");
const config = require("config");
const hash = require("helper/hash");
const fonts = require("blog/static/fonts");
const specimen = require("blog/static/fonts/specimen");

const directory = __dirname + "/..";

describe("font specimens", function () {
  it("points at the CDN file with the hash in the version", function () {
    const font = {
      id: "abel",
      specimen: { hash: "332e2a02", width: 114.64, height: 91.76 },
    };

    expect(specimen(font)).toEqual({
      specimenURL: config.cdn.origin + "/fonts/abel/text.svg?version=332e2a02",
      specimenWidth: 114.64,
      specimenHeight: 91.76,
    });
  });

  it("gives system fonts no specimen, and does not embed one in the registry", function () {
    expect(specimen({ id: "arial" })).toEqual({});
    expect(specimen(undefined)).toEqual({});
    expect(fonts.some((font) => "svg" in font)).toBe(false);
  });

  it("serves every specimen as a standalone SVG document matching its registry hash", function () {
    const withSpecimen = fonts.filter((font) => font.specimen);

    expect(withSpecimen.length).toBeGreaterThan(0);

    withSpecimen.forEach((font) => {
      const contents = fs.readFileSync(
        `${directory}/${font.id}/text.svg`,
        "utf8"
      );

      // An <img> only renders a document whose root is the <svg>
      expect(contents).toMatch(/^<\?xml[^>]*\?>\s*<svg[\s>]/, font.id);
      expect(contents).not.toContain("<html");
      expect(hash(contents).slice(0, 8)).toEqual(font.specimen.hash, font.id);
    });
  });
});
