describe("sync removing a converted file", function () {
  var sync = require("../index");
  var assets = require("storage/assets");
  var folder = require("storage/folder");
  var hash = require("helper/hash");
  var client = require("models/client");
  var Keys = require("helper/transformer/keys");

  global.test.blog();

  async function assetDirectory(blogID, path) {
    var found = [];

    for await (var relPath of assets.walk(blogID)) {
      if (relPath.indexOf("_assets/" + hash(path) + "/") === 0)
        found.push(relPath);
    }

    return found;
  }

  // Removes the file and syncs the path, as a client reporting the removal does
  async function removeAndSync(blog, path) {
    await folder.remove(blog.id, path);
    await sync(blog.id, function (syncFolder) {
      return syncFolder.update(path);
    });
  }

  it("deletes the _assets of a removed .docx", async function () {
    var path = "/Report.docx";
    var other = "/Other.docx";

    await this.blog.write({ path: path, content: "not a real docx" });
    await assets.write(this.blog.id, "_assets/" + hash(path) + "/a.png", "a");
    await assets.write(this.blog.id, "_assets/" + hash(other) + "/b.png", "b");

    await removeAndSync(this.blog, path);

    expect(await assetDirectory(this.blog.id, path)).toEqual([]);
    expect((await assetDirectory(this.blog.id, other)).length).toBe(1);
  });

  it("deletes the cached conversions which name the directory", async function () {
    var path = "/Report.docx";
    var keys = Keys(this.blog.id, "gdoc-images");
    var content = keys.content("c1");

    await this.blog.write({ path: path, content: "not a real docx" });
    await client.set(
      content,
      JSON.stringify({ output: "/_assets/" + hash(path) + "/a.png" })
    );
    await client.sAdd(keys.everything, [content]);

    await removeAndSync(this.blog, path);

    expect(await client.exists(content)).toBe(0);
    expect(await client.sMembers(keys.everything)).toEqual([]);
  });

  it("leaves _assets alone when an unrelated file is removed", async function () {
    var path = "/note.md";

    await this.blog.write({ path: path, content: "Hello" });
    await assets.write(this.blog.id, "_assets/" + hash(path) + "/a.png", "a");

    await removeAndSync(this.blog, path);

    expect((await assetDirectory(this.blog.id, path)).length).toBe(1);
  });

  it("removes the old path's directory when a file is renamed", async function () {
    var oldPath = "/Old.docx";
    var newPath = "/New.docx";

    await this.blog.write({ path: oldPath, content: "not a real docx" });
    await assets.write(
      this.blog.id,
      "_assets/" + hash(oldPath) + "/a.png",
      "a"
    );

    await folder.move(this.blog.id, oldPath, newPath);
    await assets.write(
      this.blog.id,
      "_assets/" + hash(newPath) + "/a.png",
      "a"
    );
    await sync(this.blog.id, async function (syncFolder) {
      await syncFolder.update(oldPath);
      await syncFolder.update(newPath);
    });

    expect(await assetDirectory(this.blog.id, oldPath)).toEqual([]);
    expect((await assetDirectory(this.blog.id, newPath)).length).toBe(1);
  });

  it("does not fail the removal when deleting _assets fails", async function () {
    var path = "/Report.docx";

    await this.blog.write({ path: path, content: "not a real docx" });
    await this.blog.rebuild();

    spyOn(console, "error");
    spyOn(assets, "remove").and.callFake(async function () {
      throw new Error("bucket down");
    });

    await removeAndSync(this.blog, path);

    expect(assets.remove).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
