describe("formJSON ", function () {
  var tempDir = require("../tempDir");
  var fs = require("fs-extra");
  var { promisify } = require("util");

  it("works", async function () {
    var isInTempDir = await promisify(tempDir)(__dirname);
    expect(isInTempDir).toEqual(false);
  });

  // tempDir reports a missing path with a plain string, not an Error, so this
  // stays in callback form
  it("works also", function (done) {
    tempDir(__dirname + "/foo.jpg", function (err, isInTempDir) {
      expect(isInTempDir).toEqual(undefined);
      done();
    });
  });

  it("checks a valid dir", async function () {
    var validDir = tempDir() + "foo";

    await fs.mkdir(validDir);

    var isInTempDir = await promisify(tempDir)(validDir);

    expect(isInTempDir).toEqual(true);

    await fs.rmdir(validDir);
  });
});
