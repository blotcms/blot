describe("dropbox client", function () {
  // In root means the user has set up their
  // entire Dropbox folder as their blog folder.
  // This typically only happens for 'App folders'
  describe("in root", function () {
    // Create test blog, clients & prepare Dropbox
    require("./setup")({ root: true });

    // We must repeat these setup lines in
    // the suite below for subfolders...
    beforeEach(setupDelta);
    beforeEach(addFile);
    beforeEach(removeFile);

    specs();
  });

  describe("in subfolder", function () {
    // Create test blog, clients & prepare Dropbox
    require("./setup")();

    // Suite specific methods
    beforeEach(setupDelta);
    beforeEach(addFile);
    beforeEach(removeFile);

    specs();

    xit("retrieves changes after blog folder is renamed", function (done) {
      var addFile = this.addFile;
      var oldFolder = this.account.folder;
      var newFolder = "/" + this.fake.random.uuid();

      // Other methods depend on knowing the latest folder...
      this.account.folder = newFolder;

      this.client
        .filesMove({
          from_path: oldFolder,
          to_path: newFolder,
        })
        .then(function () {
          addFile(done);
        })
        .catch(done.fail);
    });

    // This does not work right now, you'll need to go the dashboard and re-create
    xit("retrieves changes after blog folder is removed then re-created", function (done) {
      var ctx = this;

      ctx.client
        .filesDelete({
          path: ctx.account.folder,
        })
        .then(function () {
          return ctx.client.filesCreateFolder({
            path: ctx.account.folder,
            autorename: false,
          });
        })
        .then(function () {
          ctx.delta(function (err, res) {
            console.log(err);
            console.log(res);
            done();
          });
        })
        .catch(done.fail);
    });

    xit("returns a tidy error when the folder is removed", function (done) {
      var ctx = this;

      ctx.client
        .filesDelete({
          path: ctx.account.folder,
        })
        .then(function () {
          ctx.delta(function (err, res) {
            expect(err).toEqual(jasmine.any(Error));
            expect(res).toEqual(null);
            done();
          });
        })
        .catch(done.fail);
    });
  });

  function specs() {
    xit("retrieves list of changes", function (done) {
      this.delta(function (err, res) {
        if (err) return done.fail(err);

        expect(res.entries).toEqual([]);
        expect(res.has_more).toEqual(false);
        expect(res.cursor).toEqual(jasmine.any(String));

        done();
      });
    });

    xit("detects a new file", function (done) {
      this.addFile(done);
    });

    xit("detects a removed file", function (done) {
      this.removeFile(done);
    });
  }
});

describe("dropbox delta relative path normalization", function () {
  var Delta = require("../delta");
  var Path = require("path");

  it("strips leading slash when the blog folder path is known", function (done) {
    var entries = [
      {
        ".tag": "file",
        path_display: "/Blog/root.txt",
      },
    ];

    var client = {
      filesListFolder: function () {
        return Promise.resolve({
          result: { entries: entries, cursor: "cursor", has_more: false },
        });
      },
      filesGetMetadata: function () {
        return Promise.resolve({ result: { path_display: "/Blog" } });
      },
    };

    var delta = Delta(client, "folder-id", "blog-id");

    delta(null, function (err, res) {
      if (err) return done.fail(err);

      expect(res.entries.length).toEqual(1);
      expect(res.entries[0].relative_path).toEqual("root.txt");
      expect(res.entries[0].relative_path[0]).not.toEqual("/");
      done();
    });
  });

  it("handles folder metadata path case mismatches", function (done) {
    var entries = [
      {
        ".tag": "file",
        path_display: "/Apps/Blot/SiteA/root.txt",
      },
    ];

    var client = {
      filesListFolder: function () {
        return Promise.resolve({
          result: { entries: entries, cursor: "cursor", has_more: false },
        });
      },
      filesGetMetadata: function () {
        return Promise.resolve({
          result: { path_display: "/Apps/Blot/SITEA" },
        });
      },
    };

    var delta = Delta(client, "folder-id", "blog-id");

    delta(null, function (err, res) {
      if (err) return done.fail(err);

      expect(res.entries.length).toEqual(1);
      expect(res.entries[0].relative_path).toEqual("root.txt");
      done();
    });
  });

  it("normalizes root-level entries to stay inside the blog folder", function (done) {
    var entries = [
      {
        ".tag": "file",
        path_display: "/root.txt",
      },
    ];

    var client = {
      filesListFolder: function () {
        return Promise.resolve({
          result: { entries: entries, cursor: "cursor", has_more: false },
        });
      },
    };

    var delta = Delta(client, "", "blog-id");

    delta(null, function (err, res) {
      if (err) return done.fail(err);

      expect(res.entries.length).toEqual(1);
      expect(res.entries[0].relative_path).toEqual("root.txt");

      var pathOnDisk = Path.join("/tmp/blog", res.entries[0].relative_path);
      expect(pathOnDisk.indexOf("/tmp/blog")).toEqual(0);
      done();
    });
  });
});

describe("dropbox delta case-only renames", function () {
  var Delta = require("../delta");
  var fs = require("fs-extra");
  var Path = require("path");
  var blog_folder_dir = require("config").blog_folder_dir;

  var blogID = "blog_deltacaseonly" + Date.now();
  var blogDirectory = Path.join(blog_folder_dir, blogID);

  afterEach(function () {
    return fs.remove(blogDirectory);
  });

  // The Dropbox folder holds only what is listed in dropboxEntries, as
  // both the delta and the listing which checks for the old name
  function run(dropboxEntries) {
    var client = {
      filesListFolder: function () {
        return Promise.resolve({
          result: {
            entries: dropboxEntries,
            cursor: "cursor",
            has_more: false,
          },
        });
      },
      filesGetMetadata: function () {
        return Promise.resolve({ result: { path_display: "/Blog" } });
      },
    };

    return new Promise(function (resolve, reject) {
      Delta(client, "folder-id", blogID)(null, function (err, res) {
        if (err) return reject(err);
        resolve(res.entries);
      });
    });
  }

  it("deletes the old name of a file renamed only in case", async function () {
    await fs.outputFile(Path.join(blogDirectory, "Photo.txt"), "x");

    var entries = await run([
      {
        ".tag": "file",
        name: "photo.txt",
        path_display: "/Blog/photo.txt",
      },
    ]);

    expect(
      entries.map(function (entry) {
        return entry[".tag"] + ":" + entry.relative_path;
      })
    ).toEqual(["deleted:Photo.txt", "file:photo.txt"]);
  });

  it("deletes everything inside a folder renamed only in case", async function () {
    await fs.outputFile(Path.join(blogDirectory, "Sub", "a.txt"), "x");
    await fs.outputFile(Path.join(blogDirectory, "Sub", "Inner", "b.txt"), "x");

    var entries = await run([
      {
        ".tag": "folder",
        name: "sub",
        path_display: "/Blog/sub",
      },
    ]);

    expect(
      entries
        .filter(function (entry) {
          return entry[".tag"] === "deleted";
        })
        .map(function (entry) {
          return entry.relative_path;
        })
        .sort()
    ).toEqual(["Sub", "Sub/Inner", "Sub/Inner/b.txt", "Sub/a.txt"]);
  });

  it("finds a renamed file in a parent folder spelled differently", async function () {
    await fs.outputFile(Path.join(blogDirectory, "Sub", "Photo.txt"), "x");

    var entries = await run([
      {
        ".tag": "file",
        name: "photo.txt",
        path_display: "/Blog/sub/photo.txt",
      },
    ]);

    expect(
      entries.some(function (entry) {
        return entry[".tag"] === "deleted" && entry.relative_path === "sub/Photo.txt";
      })
    ).toEqual(true);
  });

  it("injects nothing when the name is the same", async function () {
    await fs.outputFile(Path.join(blogDirectory, "photo.txt"), "x");

    var entries = await run([
      {
        ".tag": "file",
        name: "photo.txt",
        path_display: "/Blog/photo.txt",
      },
    ]);

    expect(entries.length).toEqual(1);
  });
});

function setupDelta(done) {
  var Delta = require("../delta");

  var context = this;
  var account = this.account;
  var delta = new Delta(account.access_token, account.folder_id, context.blog.id);

  context.delta = function (callback) {
    delta(context.account.cursor, function (err, res) {
      if (err) return callback(err, res);
      context.account.cursor = res.cursor;
      callback(null, res);
    });
  };

  // Get to tabula rasa
  context.delta(function handle(err, res) {
    if (err) return done(err);

    if (res.has_more) return context.delta(handle);

    context.account.cursor = res.cursor;
    done();
  });
}

function addFile() {
  var ctx = this;
  this.addFile = function (callback) {
    var path = ctx.fake.path(".txt");
    var contents = ctx.fake.file();
    var pathInDropbox = ctx.account.folder + path;

    ctx.client
      .filesUpload({
        path: pathInDropbox,
        contents: contents,
      })
      .then(function () {
        ctx.delta(function (err, res) {
          if (err) return callback(err);

          if (
            res.entries.some(function (entry) {
              return (
                entry.relative_path === path &&
                entry[".tag"] === "file"
              );
            })
          )
            return callback(null, path);

          callback(new Error("No file in delta"));
        });
      })
      .catch(function (err) {
        callback(err);
      });
  };
}

function removeFile() {
  var ctx = this;
  this.removeFile = function (callback) {
    ctx.addFile(function (err, path) {
      ctx.client
        .filesDelete({
          path: ctx.account.folder + path,
        })
        .then(function () {
          ctx.delta(function (err, res) {
            if (err) return callback(err);

            if (
              res.entries.some(function (entry) {
                return (
                  entry.relative_path === path &&
                  entry[".tag"] === "deleted"
                );
              })
            )
              return callback();

            console.log(res);

            callback(new Error("No removed file in delta"));
          });
        })
        .catch(function (err) {
          callback(err);
        });
    });
  };
}
