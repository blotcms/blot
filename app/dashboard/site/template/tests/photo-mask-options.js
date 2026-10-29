const photoMaskOptions = require("../load/photo-mask-options");

describe("photo mask options", function () {
  it("selects the saved shape", function () {
    const selected = photoMaskOptions("pebble").filter((option) => option.selected);
    expect(selected.map((option) => option.value)).toEqual(["pebble"]);
  });

  it("falls back to square for missing or unknown shapes", function () {
    for (const mask of [undefined, "", "star"]) {
      expect(photoMaskOptions(mask).find((option) => option.selected).value).toBe("square");
    }
  });

  it("gives every option a label and icon", function () {
    for (const option of photoMaskOptions()) {
      expect(option.label).toBeTruthy();
      expect(option.icon).toContain("<svg");
    }
  });
});
