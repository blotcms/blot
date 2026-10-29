const photoMaskOptions = require("../load/photo-mask-options");

describe("photo mask options", function () {
  it("selects the saved shape", function () {
    const selected = photoMaskOptions("squircle").filter((option) => option.selected);
    expect(selected.map((option) => option.value)).toEqual(["squircle"]);
  });

  it("selects the Organic option for an organic shape", function () {
    const organic = photoMaskOptions("pebble").find((option) => option.organic);
    expect(organic.selected).toBe(true);
    expect(organic.value).toBe("pebble");
  });

  it("falls back to circle for missing or unknown shapes", function () {
    for (const mask of [undefined, "", "star"]) {
      expect(photoMaskOptions(mask).find((option) => option.selected).value).toBe("circle");
    }
  });

  it("gives every option a label and icon", function () {
    for (const option of photoMaskOptions()) {
      expect(option.label).toBeTruthy();
      expect(option.icon).toContain("<svg");
    }
  });
});
