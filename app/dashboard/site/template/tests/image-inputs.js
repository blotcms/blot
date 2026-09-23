describe("image inputs", function () {
  const imageInputs = require("../load/image-inputs");
  const indexInputs = require("../load/index-inputs");

  it("loads an empty-object image declaration only as an image control", function () {
    const req = { template: { locals: { profile_image: {}, profile_image_options: ["a"] } } };
    const res = { locals: {} };
    const next = jasmine.createSpy("next");

    imageInputs(req, res, next);
    indexInputs(req, res, next);

    expect(res.locals.images).toEqual([{ key: "profile_image", value: null, label: "Profile" }]);
    expect(res.locals.index_page.some((input) => input.key === "profile_image")).toBe(false);
  });
});
