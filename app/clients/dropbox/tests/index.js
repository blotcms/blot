describe("dropbox client", function () {
  // Create test user and tmp directory
  require("./setup")();

  xit("syncs a removed file", function (done) {
    var client = this.client;
    var webhook = this.webhook;
    var path = this.fake.path(".txt");
    var contents = this.fake.file();
    var blog = this.blog;
    var blogFolder = require("storage/folder");
    var afterSync = this.afterSync;
    var folder = this.folder;

    client
      .filesUpload({ path: folder + path, contents: contents })
      .then(function () {
        webhook(function (err) {
          if (err) return done.fail(err);

          afterSync(function (err) {
            if (err) return done.fail(err);

            client
              .filesDelete({ path: folder + path })
              .then(function () {
                webhook(function (err) {
                  if (err) return done.fail(err);

                  afterSync(function (err) {
                    if (err) return done.fail(err);

                    blogFolder.exists(blog.id, path).then(function (exists) {
                      expect(exists).toEqual(false);
                      done();
                    }, done.fail);
                  });
                });
              })
              .catch(function (err) {
                return done.fail(new Error(err.message));
              });
          });
        });
      })
      .catch(function (err) {
        return done.fail(new Error(err.message));
      });
  });

  xit("syncs a new file", function (done) {
    var client = this.client;
    var webhook = this.webhook;
    var path = this.fake.path(".txt");
    var contents = this.fake.file();
    var blog = this.blog;
    var blogFolder = require("storage/folder");
    var afterSync = this.afterSync;
    var otherContents;

    client
      .filesUpload({ path: this.folder + path, contents: contents })
      .then(function () {
        webhook(function (err) {
          if (err) return done.fail(err);

          afterSync(function (err) {
            if (err) return done.fail(err);

            blogFolder.read(blog.id, path).then(function (buffer) {
              otherContents = buffer.toString("utf-8");

              expect(otherContents).toEqual(contents);

              done();
            }, done.fail);
          });
        });
      })
      .catch(function (err) {
        console.log(err);
        return done.fail(new Error(err.message));
      });
  });
});
