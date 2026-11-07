describe("dropbox client", function () {
  // Create test user and tmp directory
  require("./setup")();

  var folder = require("storage/folder");
  var write = require("../write");
  var remove = require("../remove");

  beforeEach(function () {
    this.path = this.fake.path(".txt");
  });

  afterEach(async function () {
    expect(await folder.exists(this.blog.id, this.path)).toEqual(false);

    let res;

    try {
      res = await this.client.filesGetMetadata({
        path: this.folder + this.path,
        include_deleted: true,
      });
    } catch (err) {
      if (err && err.status === 409) return;
      throw new Error(err, { cause: err });
    }

    // Verify file no longer exists on Dropbox
    expect(res[".tag"]).toEqual("deleted");
  });

  xit("does not return an error when you remove a non-existent file", async function () {
    await remove(this.blog.id, this.path);
  });

  xit("does not return an error when you remove a file which exists on Dropbox but not on Blot", async function () {
    var path = this.path;
    var blog = this.blog;
    var contents = this.fake.file();

    await write(blog.id, path, contents);
    await folder.remove(blog.id, path);
    await remove(blog.id, path);
  });

  xit("does not return an error when you remove a file which exists on Blot but not on Dropbox", async function () {
    var blog = this.blog;
    var path = this.path;

    await folder.write(blog.id, path, this.fake.file());
    await remove(blog.id, path);
  });

  xit("removes a file", async function () {
    var contents = this.fake.file();
    var blog = this.blog;
    var path = this.path;

    await write(blog.id, path, contents);
    await remove(blog.id, path);
  });
});
