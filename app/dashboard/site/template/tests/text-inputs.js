const textInputs = require("../load/text-inputs");

describe("template text inputs", function () {
  function run(locals) {
    const res = { locals: {} };
    textInputs({ template: { locals } }, res, function () {});
    return res.locals.text_inputs;
  }

  it("shows the listed string locals in order, with labels", function () {
    const result = run({
      tagline: "Since 1951",
      address: "",
      demo_folder: "stamps",
      text_inputs: ["address", "tagline"],
      text_input_labels: { tagline: "Strapline" },
    });
    expect(result).toEqual([
      { key: "address", label: "Address", value: "" },
      { key: "tagline", label: "Strapline", value: "Since 1951" },
    ]);
  });

  it("skips listed keys that aren't strings", function () {
    expect(run({ page_size: 5, text_inputs: ["page_size"] })).toEqual([]);
  });

  it("shows nothing for a template that lists none", function () {
    expect(run({ tagline: "x" })).toEqual([]);
  });
});
