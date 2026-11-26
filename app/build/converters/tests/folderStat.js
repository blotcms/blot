const folder = require("storage/folder");
const File = require("models/file");
const folderStat = require("build/converters/folderStat");

describe("folderStat", function () {
  global.test.blog();

  async function write(test, path, text) {
    await folder.write(test.blog.id, path, text);
  }

  it("gives size and a whole-millisecond mtime", async function () {
    await write(this, "/a.txt", "hello");

    const expected = await folder.stat(this.blog.id, "/a.txt");
    const stat = await folderStat(this.blog.id, "/a.txt");

    expect(stat.size).toBe(5);
    expect(stat.mtime).toEqual(new Date(Math.round(expected.modified)));
  });

  it("withLocal gives the same stat from one read of the index", async function () {
    await write(this, "/a.txt", "hello");

    const expected = await folderStat(this.blog.id, "/a.txt");
    spyOn(File, "get").and.callThrough();

    const { localPath, stat } = await folderStat.withLocal(
      this.blog.id,
      "/a.txt"
    );

    expect(typeof localPath).toBe("string");
    expect(stat).toEqual(expected);
    expect(File.get).toHaveBeenCalledTimes(1);
  });

  it("withLocalHeld gives the same stat and fn's result from one read of the index", async function () {
    await write(this, "/a.txt", "hello");

    const expected = await folderStat(this.blog.id, "/a.txt");
    spyOn(File, "get").and.callThrough();

    const { stat, value } = await folderStat.withLocalHeld(
      this.blog.id,
      "/a.txt",
      async (localPath) => "held " + typeof localPath
    );

    expect(value).toBe("held string");
    expect(stat).toEqual(expected);
    expect(File.get).toHaveBeenCalledTimes(1);
  });
});
