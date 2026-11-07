describe("tempDir", function () {
  var tempDir = require("../tempDir");
  var fs = require("fs-extra");

  it("returns the temporary directory", function () {
    expect(tempDir()).toMatch(/\/$/);
  });

  it("reports a path outside the temporary directory", async function () {
    expect(await tempDir.isInside(__dirname)).toEqual(false);
  });

  it("rejects a path that does not exist", async function () {
    await expectAsync(
      tempDir.isInside(__dirname + "/foo.jpg")
    ).toBeRejectedWithError(/does not point to a file/);
  });

  it("checks a valid dir", async function () {
    var validDir = tempDir() + "foo";

    await fs.mkdir(validDir);

    expect(await tempDir.isInside(validDir)).toEqual(true);

    await fs.rmdir(validDir);
  });
});
