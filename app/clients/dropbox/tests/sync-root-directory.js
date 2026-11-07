describe("dropbox client", function () {
  // Create test user and tmp directory
  require("./setup")({ root: true });

  var folder = require("storage/folder");
  var write = require("../write");
  var sync = require("../sync");

  xit("syncs changes to the root folder of a Dropbox", function (done) {
    var blog = this.blog;

    var path = this.fake.path(".txt");
    var contents = this.fake.file();
    var contentsInBlogDirectory;

    write(blog.id, path, contents).then(function () {
      sync(blog)
        .then(
          () => null,
          (err) => err
        )
        .then(function (err) {
          if (err) return done.fail(err);

          folder
            .read(blog.id, path)
            .then(function (buffer) {
              contentsInBlogDirectory = buffer.toString("utf-8");
              expect(contentsInBlogDirectory).toEqual(contents);
              done();
            })
            .catch(function (e) {
              return folder.listNames(blog.id, "/").then(function (names) {
                var message = [
                  "Error " + e.message + " " + e.code,
                  "Contents of blog folder: " + names,
                ].join("\n");
                done.fail(new Error(message));
              }, done.fail);
            });
        });
    }, done.fail);
  });
});
