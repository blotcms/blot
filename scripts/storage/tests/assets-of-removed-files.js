describe("scripts/storage/assets-of-removed-files", function () {
  var assets = require("storage/assets");
  var folder = require("storage/folder");
  var hash = require("helper/hash");
  var client = require("models/client");
  var Keys = require("helper/transformer/keys");
  var Entries = require("models/entries");
  var Entry = require("models/entry");
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

  it("matches a folder key with a space, a % and a CJK character", async function () {
    var id = this.blog.id;
    var path = "/My Notes 100% 日本語.docx";
    var directory = hash(path);

    await folder.write(id, path, "x");
    await assets.write(id, "_assets/" + directory + "/image.png", "png");

    await cleanBlog(id, true, Date.now() + TWO_DAYS);

    expect(await names(id)).toContain(directory);
  });

  it("keeps a directory an entry still links, but not one only a deleted entry links", async function () {
    var id = this.blog.id;
    var linked = hash("/copy-of-a-file.docx");
    var forgotten = hash("/deleted-entry-file.docx");

    await assets.write(id, "_assets/" + linked + "/image.png", "png");
    await assets.write(id, "_assets/" + forgotten + "/image.png", "png");

    spyOn(Entries, "getAllIDs").and.callFake(async () => ["/a", "/b"]);
    spyOn(Entry, "get").and.callFake(async () => [
      { html: '<img src="/_assets/' + linked + '/image.png">' },
      { deleted: true, html: '<img src="/_assets/' + forgotten + '/a.png">' },
    ]);

    var result = await cleanBlog(id, true, Date.now() + TWO_DAYS);
    var remaining = await names(id);

    expect(result.referenced).toBe(1);
    expect(remaining).toContain(linked);
    expect(remaining).not.toContain(forgotten);
  });

  it("skips a blog whose folder listing has no files", async function () {
    var id = this.blog.id;

    await folder.remove(id, "/Kept.docx");
    await folder.remove(id, "/Folder");
    await folder.remove(id, "/café.docx".normalize("NFD"));

    var before = await names(id);
    var result = await cleanBlog(id, true, Date.now() + TWO_DAYS);

    expect(result.skipped).toBe(1);
    expect(await names(id)).toEqual(before);
  });

  it("deletes the cached conversions which name a deleted directory, and no others", async function () {
    var id = this.blog.id;
    var doomed = Keys(id, "img-converter");
    var kept = Keys(id, "img-converter");
    var content = doomed.content("c1");
    var other = kept.content("c2");

    await client.set(
      content,
      JSON.stringify({
        relativePath: "/_assets/" + this.hashes.stale + "/a.png",
      })
    );
    await client.set(doomed.url.content("u1"), "c1");
    await client.set(doomed.url.headers("u1"), "{}");
    await client.set(
      other,
      JSON.stringify({
        relativePath: "/_assets/" + this.hashes.kept + "/a.png",
      })
    );
    await client.sAdd(doomed.everything, [
      content,
      doomed.url.content("u1"),
      doomed.url.headers("u1"),
      other,
    ]);

    await cleanBlog(id, false, Date.now() + TWO_DAYS);
    expect(await client.exists(content)).toBe(1);

    await cleanBlog(id, true, Date.now() + TWO_DAYS);

    expect(await client.exists(content)).toBe(0);
    expect(await client.exists(doomed.url.content("u1"))).toBe(0);
    expect(await client.exists(doomed.url.headers("u1"))).toBe(0);
    expect(await client.exists(other)).toBe(1);
    expect(await client.sMembers(doomed.everything)).toEqual([other]);

    await client.del([other, doomed.everything]);
  });
});
