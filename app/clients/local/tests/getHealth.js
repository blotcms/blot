describe("local client health", function () {
  it("does not implement getHealth", function () {
    expect(require("../index").getHealth).toBeUndefined();
  });
});
