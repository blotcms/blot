describe("Blot's dashboard'", function () {
  global.test.site({ login: true });
  global.test.timeout(5 * 60 * 1000); // Set timeout to 5 minutes

  it("has no broken links", async function () {
    await this.checkBrokenLinks();
  });
});
