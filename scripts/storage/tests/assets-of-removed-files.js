describe("scripts/storage/assets-of-removed-files", function () {
  var assets = require("storage/assets");
  var folder = require("storage/folder");
  var hash = require("helper/hash");
  var { cleanBlog } = require("../assets-of-removed-files");

  global.test.blog();

  var TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

  async function names(blogID) {
    return (await assets.list(blogID, "_assets")).sort();
  }

  beforeEach(async function () {
    var id = this.blog.id;

    await folder.write(id, "/Kept.docx", "x");
    await folder.write(id, "/Folder/Mixed Case.docx", "x");
    await folder.write(id, "/café.docx".normalize("NFD"), "x");

    this.hashes = {
      kept: hash("/Kept.docx"),
      lower: hash("/folder/mixed case.docx"),
      unicode: hash("/café.docx".normalize("NFD")),
      stale: hash("/Gone.docx"),
    };

    for (var name of Object.values(this.hashes))
      await assets.write(id, "_assets/" + name + "/image.png", "png");

    // a directory which isn't a hash isn't ours
    await assets.write(id, "_assets/notes/readme.txt", "x");
  });

  it("writes nothing in report mode", async function () {
    var before = await names(this.blog.id);
    var result = await cleanBlog(this.blog.id, false, Date.now() + TWO_DAYS);

    expect(result.stale).toBe(1);
    expect(result.objects).toBe(1);
    expect(await names(this.blog.id)).toEqual(before);
  });

  it("deletes an unmatched directory and keeps the others", async function () {
    var result = await cleanBlog(this.blog.id, true, Date.now() + TWO_DAYS);
    var remaining = await names(this.blog.id);

    expect(result.stale).toBe(1);
    expect(remaining).not.toContain(this.hashes.stale);
    expect(remaining).toContain(this.hashes.kept);
    expect(remaining).toContain("notes");
  });

  it("keeps a directory whose source differs only by case or normalization", async function () {
    await cleanBlog(this.blog.id, true, Date.now() + TWO_DAYS);
    var remaining = await names(this.blog.id);

    expect(remaining).toContain(this.hashes.lower);
    expect(remaining).toContain(this.hashes.unicode);
  });

  it("keeps a directory newer than a day", async function () {
    var result = await cleanBlog(this.blog.id, true);

    expect(result.stale).toBe(0);
    expect(result.recent).toBe(1);
    expect(await names(this.blog.id)).toContain(this.hashes.stale);
  });
});
