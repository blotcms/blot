describe("ignoredFiles", function () {
  const IgnoredFiles = require("models/ignoredFiles");

  // Create a test user and blog before each spec
  global.test.blog();

  it("adds, reads and drops with promises", async function () {
    const id = this.blog.id;

    await IgnoredFiles.add(id, "/big.bin", "TOO_LARGE");

    expect(await IgnoredFiles.isIt(id, "/big.bin")).toBe(true);
    expect(await IgnoredFiles.getStatus(id, "/big.bin")).toEqual("TOO_LARGE");
    expect(await IgnoredFiles.getStatuses(id, ["/big.bin", "/other"])).toEqual({
      "/big.bin": "TOO_LARGE",
    });
    expect(await IgnoredFiles.getArray(id)).toEqual([
      { path: "big.bin", reason: "too large", url: "/help" },
    ]);

    await IgnoredFiles.drop(id, "/big.bin");
    expect(await IgnoredFiles.isIt(id, "/big.bin")).toBe(false);

    await IgnoredFiles.add(id, "/a", "WRONG_TYPE");
    await IgnoredFiles.flush(id);
    expect(await IgnoredFiles.get(id)).toEqual({});
  });

  it("still calls back", function (done) {
    IgnoredFiles.add(this.blog.id, "/x", "TOO_LARGE", (err) => {
      expect(err).toBe(null);
      IgnoredFiles.getStatus(this.blog.id, "/x", (err, status) => {
        expect(status).toEqual("TOO_LARGE");
        done();
      });
    });
  });
});
