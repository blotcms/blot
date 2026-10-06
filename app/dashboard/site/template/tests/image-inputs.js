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
    expect(res.locals.profile_image_control).toEqual(res.locals.images[0]);
    expect(res.locals.other_images).toEqual([]);
    expect(res.locals.index_page.some((input) => input.key === "profile_image")).toBe(false);
  });

  it("separates profile_image from the other image controls", function () {
    const req = {
      template: {
        locals: {
          hero_image: {},
          profile_image: {},
        },
      },
    };
    const res = { locals: {} };
    const next = jasmine.createSpy("next");

    imageInputs(req, res, next);

    expect(res.locals.profile_image_control.key).toBe("profile_image");
    expect(res.locals.other_images).toEqual([
      { key: "hero_image", value: null, label: "Hero" },
    ]);
  });
});
