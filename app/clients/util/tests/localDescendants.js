describe("clients/util localDescendants", function () {
  const fs = require("fs-extra");
  const { join } = require("path");
  const { tmpdir } = require("os");
  const localDescendants = require("../localDescendants");

  const directory = join(tmpdir(), "localDescendants-" + Date.now());

  afterEach(async function () {
    await fs.remove(directory);
  });

  it("lists everything inside a folder as blog paths, parents first", async function () {
    await fs.outputFile(join(directory, "a.txt"), "a");
    await fs.outputFile(join(directory, "sub", "b.txt"), "b");
    await fs.ensureDir(join(directory, "empty"));

    const paths = await localDescendants(directory, "/Folder");

    expect(paths.sort()).toEqual(
      ["/Folder/a.txt", "/Folder/empty", "/Folder/sub", "/Folder/sub/b.txt"].sort()
    );
    expect(paths.indexOf("/Folder/sub")).toBeLessThan(
      paths.indexOf("/Folder/sub/b.txt")
    );
  });

  it("is empty for a file or a missing path", async function () {
    await fs.outputFile(join(directory, "a.txt"), "a");

    expect(await localDescendants(join(directory, "a.txt"), "/a.txt")).toEqual([]);
    expect(await localDescendants(join(directory, "missing"), "/missing")).toEqual([]);
  });
});
