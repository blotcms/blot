describe("template image crop controls", function () {
  const initializeCrop = require("../../../../views/dashboard/template/controls/image-crop");

  it("clears crop coordinates when another image is selected", function () {
    const listeners = {};
    const input = {
      files: [],
      addEventListener(name, callback) { listeners[`input:${name}`] = callback; },
    };
    const selection = {
      style: {},
      addEventListener(name, callback) { listeners[`selection:${name}`] = callback; },
      setAttribute() {},
    };
    const fields = {
      x: { value: "" },
      y: { value: "" },
      size: { value: "" },
    };
    const form = {
      dataset: {},
      querySelector(selector) {
        return {
          "[data-crop-input]": input,
          "[data-cropper]": { hidden: true },
          "[data-crop-image]": { clientWidth: 100, clientHeight: 50 },
          "[data-crop-selection]": selection,
          "[data-crop-x]": fields.x,
          "[data-crop-y]": fields.y,
          "[data-crop-size]": fields.size,
        }[selector];
      },
    };
    const originalWindow = global.window;
    global.window = { addEventListener() {} };
    spyOn(URL, "createObjectURL").and.returnValues("blob:first", "blob:second");
    spyOn(URL, "revokeObjectURL");

    try {
      initializeCrop(form);
      input.files = [{}];
      listeners["input:change"]();
      fields.x.value = "0.25";
      fields.y.value = "0.1";
      fields.size.value = "0.5";

      input.files = [{}];
      listeners["input:change"]();

      expect(fields.x.value).toBe("");
      expect(fields.y.value).toBe("");
      expect(fields.size.value).toBe("");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:first");
    } finally {
      global.window = originalWindow;
    }
  });
});
