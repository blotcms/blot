const ERROR = require("../error");

describe("render error factory", function () {
  it("builds a named error with its predefined message", function () {
    const err = ERROR.UNCLOSED();

    expect(err.message).toEqual("Your template has an unclosed tag");
    expect(err.code).toEqual("BADTEMPLATE");
  });

  it("falls back to a default message when called directly", function () {
    const err = ERROR();

    expect(err.message).toEqual("Your template was badly formed");
    expect(err.code).toEqual("BADTEMPLATE");
  });
});
