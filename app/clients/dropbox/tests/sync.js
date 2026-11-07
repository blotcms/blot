describe("dropbox client", function () {
  // Create test user and tmp directory
  require("./setup")();

  var blogFolder = require("storage/folder");
  var write = require("../write");
  var sync = require("../sync");

  xit("syncs changes when the blog folder is moved", function (done) {
    var folder = this.folder;
    var newFolder =
      "/" + this.fake.random.word() + " " + this.fake.random.word();
    var client = this.client;
    var blog = this.blog;

    var path = this.fake.path(".txt");
    var contents = this.fake.file();
    var secondPath = this.fake.path(".txt");
    var secondContents = this.fake.file();

    write(blog.id, path, contents).then(function () {
      sync(blog)
        .then(
          () => null,
          (err) => err
        )
        .then(function (err) {
          if (err) return done.fail(err);

          client
            .filesMove({
              from_path: folder,
              to_path: newFolder,
              autorename: false,
            })
            .then(function () {
              write(blog.id, secondPath, secondContents).then(function () {
                sync(blog)
                  .then(
                    () => null,
                    (err) => err
                  )
                  .then(function (err) {
                    if (err) return done.fail(err);

                    Promise.all([
                      blogFolder.read(blog.id, path),
                      blogFolder.read(blog.id, secondPath),
                    ]).then(function (buffers) {
                      expect(buffers[0].toString("utf-8")).toEqual(contents);
                      expect(buffers[1].toString("utf-8")).toEqual(
                        secondContents
                      );

                      done();
                    }, done.fail);
                  });
              }, done.fail);
            })
            .catch(function (err) {
              done.fail(err);
            });
        });
    }, done.fail);
  });
});
