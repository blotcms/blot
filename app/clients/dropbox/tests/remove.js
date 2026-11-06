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

  xit("does not return an error when you remove a non-existent file", function (done) {
    remove(this.blog.id, this.path, done);
  });

  xit("does not return an error when you remove a file which exists on Dropbox but not on Blot", function (done) {
    var path = this.path;
    var blog = this.blog;
    var contents = this.fake.file();

    write(blog.id, path, contents, function (err) {
      if (err) return done.fail(err);

      folder.remove(blog.id, path).then(function () {
        remove(blog.id, path, done);
      }, done.fail);
    });
  });

  xit("does not return an error when you remove a file which exists on Blot but not on Dropbox", function (done) {
    var blog = this.blog;
    var path = this.path;

    folder.write(blog.id, path, this.fake.file()).then(function () {
      remove(blog.id, path, done);
    }, done.fail);
  });

  xit("removes a file", function (done) {
    var contents = this.fake.file();
    var blog = this.blog;
    var path = this.path;

    write(blog.id, path, contents, function (err) {
      if (err) return done.fail(err);

      remove(blog.id, path, done);
    });
  });
});
