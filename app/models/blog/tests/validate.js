describe("Blog.validate", function () {
  const validate = require("../validate");

  // Create a test user and blog before each spec
  global.test.blog();

  it("resolves to the valid updates", async function () {
    const valid = await validate(this.blog.id, {
      title: "  A title ",
      timeZone: "Not/AZone",
      menu: [],
    });

    expect(valid.title).toEqual("A title");
    expect(valid.timeZone).toEqual("UTC");
    expect(valid.menu).toEqual([]);
  });

  it("rejects with an errors object keyed by field", async function () {
    let errors;

    try {
      await validate(this.blog.id, {
        title: "x".repeat(71),
        domain: "not a domain!",
      });
    } catch (err) {
      errors = err;
    }

    expect(errors.title).toEqual(jasmine.any(Error));
    expect(errors.title.message).toEqual("Choose a title under 70 characters");
    expect(errors.domain).toEqual("Please enter a valid hostname");
  });

  it("throws when a field validator is given a callback", async function () {
    // The callback form is gone: passing one throws instead of calling back.
    try {
      await require("../validate/title")(this.blog.id, " Hi ", function () {});
      fail("should have thrown");
    } catch (err) {
      expect(err.message).toMatch(/no longer takes a callback/);
    }
  });
});
