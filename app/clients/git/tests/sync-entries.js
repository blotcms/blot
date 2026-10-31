// The entries Blot builds from a push, read through the entry model, for the
// four changes a sync can find: a file added, updated, renamed or deleted.
// Part of the regression suite for the git client (#2259): these specs only
// use a real git client over HTTP and Blot's models, so they must keep passing
// when the server side is rewritten.
describe("git client sync: entries", function () {
  require("./setup")({ clone: false, client: true, once: true });

  var fs = require("fs-extra");
  var helpers = require("./setup/helpers");

  afterEach(async function () {
    await this.local.expectSynced();
  });

  it("builds an entry for a new file", async function () {
    var path = "/entries/added.txt";
    var unicodePath = "/entries/café ☕.txt";

    await this.local.commitFiles({
      [path]: "# Added\n\nThe body of the added post",
      [unicodePath]: "# Coffee\n\nA post with a path in unicode",
    });
    await this.local.push();

    var entry = await helpers.entry(this.blog.id, path);

    expect(entry).toBeDefined();
    expect(entry.path).toBe(path);
    expect(entry.deleted).toBe(false);
    expect(entry.html).toContain("The body of the added post");

    var unicodeEntry = await helpers.entry(this.blog.id, unicodePath.normalize());

    expect(unicodeEntry).toBeDefined();
    expect(unicodeEntry.deleted).toBe(false);
    expect(unicodeEntry.html).toContain("A post with a path in unicode");
  });

  it("rebuilds the entry for an updated file", async function () {
    var path = "/entries/updated.txt";

    await this.local.writeAndPush(path, "# Updated\n\nThe first version of the body");

    var first = await helpers.entry(this.blog.id, path);

    expect(first.html).toContain("The first version of the body");

    await this.local.writeAndPush(path, "# Updated\n\nThe second version of the body");

    var second = await helpers.entry(this.blog.id, path);

    expect(second.deleted).toBe(false);
    expect(second.html).toContain("The second version of the body");
    expect(second.html).not.toContain("The first version of the body");
  });

  it("drops the entry of a renamed file and builds one at the new path", async function () {
    // The old path sorts before the new one, so a sync finds the removal first
    var path = "/entries/a-before-rename.txt";
    var newPath = "/entries/b-after-rename.txt";

    await this.local.writeAndPush(path, "# Renamed\n\nA post which is renamed");

    var before = await helpers.entry(this.blog.id, path);

    expect(before.deleted).toBe(false);

    await fs.move(this.local.path(path), this.local.path(newPath));
    await this.local.commit("Rename the post");
    await this.local.push();

    var old = await helpers.entry(this.blog.id, path);
    var renamed = await helpers.entry(this.blog.id, newPath);

    expect(old.deleted).toBe(true);
    expect(renamed.deleted).toBe(false);
    expect(renamed.html).toContain("A post which is renamed");

    // Blot recognises the rename: the post keeps its date and its URL
    expect(renamed.created).toBe(before.created);
    expect(renamed.url).toBe(before.url);
  });

  it("marks the entry of a deleted file as deleted", async function () {
    var path = "/entries/deleted.txt";

    await this.local.writeAndPush(path, "# Deleted\n\nA post which is deleted");

    expect((await helpers.entry(this.blog.id, path)).deleted).toBe(false);

    await this.local.remove(path);
    await this.local.commit("Delete the post");
    await this.local.push();

    // The entry stays in the database as a tombstone
    var entry = await helpers.entry(this.blog.id, path);

    expect(entry).toBeDefined();
    expect(entry.deleted).toBe(true);
  });
});
