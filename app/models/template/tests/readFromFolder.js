describe("template", function () {
  var folder = require("storage/folder");
  var get = require("../index").getView;

  var create = require("../index").create;
  var readFromFolder = require("../index").readFromFolder;
  var setView = require("../index").setView;
  var getViewByURL = require("helper/withCallback")(
    require("../index").getViewByURL
  );

  require("./setup")({ createTemplate: true });

  beforeEach(function (done) {
    var name = this.blog.handle;

    // readFromFolder takes a path in the blog's folder, which is removed
    // along with the blog
    this.dir = "/Templates/" + name;

    // Writes a file into the template's folder in the blog's folder
    this.put = (path, contents) =>
      folder.write(this.blog.id, this.dir + path, contents);

    create(this.blog.id, name, { localEditing: true }, done);
  });

  it("reads template properties from package.json", function (done) {
    this.put("/package.json", JSON.stringify({ locals: { foo: "bar" } })).then(
      () => {
        readFromFolder(this.blog.id, this.dir, function (err, template) {
          if (err) return done.fail(err);

          expect(template.locals.foo).toEqual("bar");
          done();
        });
      },
      done.fail
    );
  });

  it("marks a template read from a folder without package.json as locally edited", function (done) {
    var setMetadata = require("../index").setMetadata;
    var makeID = require("../util/makeID");
    var test = this;

    this.put("/entries.html", "{{title}}").then(function () {
      setMetadata(
        makeID(test.blog.id, test.blog.handle),
        { localEditing: false },
        function (err) {
          if (err) return done.fail(err);

          readFromFolder(test.blog.id, test.dir, function (err, template) {
            if (err) return done.fail(err);

            expect(template.localEditing).toEqual(true);
            done();
          });
        }
      );
    }, done.fail);
  });

  it("leaves the blog's cache alone when a sync reads an unchanged template", async function () {
    var { promisify } = require("util");
    var read = promisify(readFromFolder);
    var getMetadata = promisify(require("../index").getMetadata);
    var getBlog = promisify(require("models/blog").get);
    var setBlog = promisify(require("models/blog").set);
    var makeID = require("../util/makeID");
    var id = makeID(this.blog.id, this.blog.handle);

    await this.put("/entries.html", "{{title}}");
    await read(this.blog.id, this.dir);
    await setBlog(this.blog.id, { template: id });

    var blogCacheID = (await getBlog({ id: this.blog.id })).cacheID;
    var templateCacheID = (await getMetadata(id)).cacheID;

    await read(this.blog.id, this.dir);

    expect((await getBlog({ id: this.blog.id })).cacheID).toEqual(blogCacheID);
    expect((await getMetadata(id)).cacheID).toEqual(templateCacheID);

    await this.put("/entries.html", "{{title}}!");
    await read(this.blog.id, this.dir);

    expect((await getBlog({ id: this.blog.id })).cacheID).not.toEqual(
      blogCacheID
    );
  });

  it("explains what is wrong with an invalid package.json", function (done) {
    this.put("/package.json", '{\n  "name": "Example",\n}').then(() => {
      readFromFolder(this.blog.id, this.dir, function (err, template) {
        if (err) return done.fail(err);

        var message = template.errors["package.json"];

        // The message has to describe the file, not our own failure to
        // rewrite the parse error
        expect(message).not.toContain("Cannot read properties");
        expect(message.toLowerCase()).toContain("json");
        done();
      });
    }, done.fail);
  });

  it("ignores view files which are too large", function (done) {
    // 3mb of random data should exceed the limit of 2.5mb
    this.put("/style.css", require("crypto").randomBytes(3 * 1000 * 1000)).then(
      () => {
        readFromFolder(this.blog.id, this.dir, function (err, template) {
          if (err) return done.fail(err);

          getViewByURL(template.id, "/style.css", function (err, name) {
            if (err) return done.fail(err);

            expect(name).toEqual(null);
            done();
          });
        });
      },
      done.fail
    );
  });

  it("reads a view's properties from package.json", function (done) {
    Promise.all([
      this.put("/style.css", "body {color:pink}"),
      this.put(
        "/package.json",
        JSON.stringify({
          locals: { foo: "bar" },
          views: { "style.css": { url: "/test", locals: { baz: "bat" } } },
        })
      ),
    ]).then(() => {
      readFromFolder(this.blog.id, this.dir, function (err, template) {
        if (err) return done.fail(err);

        getViewByURL(template.id, "/test", function (err, name) {
          if (err) return done.fail(err);

          expect(name).toEqual("style.css");
          done();
        });
      });
    }, done.fail);
  });

  it("assigns a view a URL automatically", function (done) {
    this.put("/style.css", "body {color:pink}").then(() => {
      readFromFolder(this.blog.id, this.dir, function (err, template) {
        if (err) return done.fail(err);

        getViewByURL(template.id, "/style.css", function (err, name) {
          if (err) return done.fail(err);

          expect(name).toEqual("style.css");
          done();
        });
      });
    }, done.fail);
  });

  // By default, when a new view is read from a template folder its URL
  // is set to its name, i.e. tags.html will be accessible at /tags.html
  // on the blog. It's possible to edit this URL/route on the template
  // editor. We want to preserve this URL if the template is ever read
  // from a folder in future.
  it("will not clobber the URL for a view set elsewhere", function (done) {
    var templateFolder = this.dir;
    var blogID = this.blog.id;

    this.put("/style.css", "body {color:pink}").then(() => {
      readFromFolder(blogID, templateFolder, function (err, template) {
        if (err) return done.fail(err);

        setView(
          template.id,
          { name: "style.css", url: "/foo" },
          function (err) {
            if (err) return done.fail(err);

            readFromFolder(blogID, templateFolder, function (err, template) {
              if (err) return done.fail(err);

              getViewByURL(template.id, "/foo", function (err, name) {
                if (err) return done.fail(err);

                expect(name).toEqual("style.css");
                done();
              });
            });
          }
        );
      });
    }, done.fail);
  });

  it("removes a view when you remove its file", function (done) {
    const dir = this.dir;
    const blogID = this.blog.id;

    Promise.all([
      this.put("/hello.html", "Hello, world!"),
      this.put("/test.html", "Hello, test!"),
    ]).then(() => {
      readFromFolder(blogID, dir, function (err, template) {
        if (err) return done.fail(err);
        get(template.id, "test.html", function (err, view) {
          expect(view.content).toEqual("Hello, test!");

          folder.remove(blogID, dir + "/test.html").then(function () {
            readFromFolder(blogID, dir, function (err) {
              if (err) return done.fail(err);
              get(template.id, "test.html", function (err, view) {
                expect(err.message.includes("No view")).toBe(true);
                expect(view).toEqual(undefined);
                done();
              });
            });
          }, done.fail);
        });
      });
    }, done.fail);
  });

  it("reads a view's content from a folder", function (done) {
    this.put("/style.css", "body {color:pink}").then(() => {
      readFromFolder(this.blog.id, this.dir, function (err, template) {
        if (err) return done.fail(err);

        get(template.id, "style", function (err, view) {
          if (err) return done.fail(err);
          expect(view.content).toEqual("body {color:pink}");
          done();
        });
      });
    }, done.fail);
  });

  // A sync waits on buildFromFolder, which waits on this callback, before it
  // releases the blog's folder lock. If an error (e.g. Redis rejecting writes
  // during a host cutover) never reaches the callback the blog can't sync
  // again until the process restarts.
  describe("when Redis fails", function () {
    var originals = {};

    function readFromFolderWith(stubs) {
      Object.keys(stubs).forEach(function (name) {
        var path = require.resolve("../" + name);
        originals[path] = require.cache[path];
        require.cache[path] = {
          id: path,
          filename: path,
          loaded: true,
          exports: stubs[name],
        };
      });

      var path = require.resolve("../readFromFolder");
      originals[path] = require.cache[path];
      delete require.cache[path];
      return require("../readFromFolder");
    }

    afterEach(function () {
      Object.keys(originals).forEach(function (path) {
        if (originals[path]) require.cache[path] = originals[path];
        else delete require.cache[path];
      });
      originals = {};
    });

    function redisError() {
      return new Error("NOREPLICAS Not enough good replicas to write.");
    }

    // Fails the spec if the callback fires more than once
    function once(done, check) {
      var calls = 0;
      return function () {
        if (++calls > 1) return done.fail(new Error("Callback invoked twice"));
        check.apply(null, arguments);
        setTimeout(done, 100);
      };
    }

    it("passes an error creating a new template to the callback", function (done) {
      var dir = this.dir + "/new-template";
      var error = redisError();
      var create = jasmine
        .createSpy("create")
        .and.callFake(function (owner, name, metadata, callback) {
          callback(error);
        });

      folder
        .write(this.blog.id, dir + "/entries.html", "{{#entries}}{{/entries}}")
        .then(() => {
          readFromFolderWith({ create: create })(
            this.blog.id,
            dir,
            once(done, function (err) {
              expect(create).toHaveBeenCalled();
              expect(err).toBe(error);
            })
          );
        }, done.fail);
    });

    it("passes an error reading the template's metadata to the callback", function (done) {
      var error = redisError();
      var create = jasmine.createSpy("create");
      var getMetadata = function (id, callback) {
        callback(error);
      };

      this.put("/style.css", "body {color:pink}").then(() => {
        readFromFolderWith({ create: create, getMetadata: getMetadata })(
          this.blog.id,
          this.dir,
          once(done, function (err) {
            // Only a missing template should be created
            expect(create).not.toHaveBeenCalled();
            expect(err).toBe(error);
          })
        );
      }, done.fail);
    });

    it("passes an error saving the template's metadata to the callback", function (done) {
      var error = redisError();
      var setMetadata = function (id, updates, callback) {
        callback(error);
      };

      this.put("/style.css", "body {color:pink}").then(() => {
        readFromFolderWith({ setMetadata: setMetadata })(
          this.blog.id,
          this.dir,
          once(done, function (err) {
            expect(err).toBe(error);
          })
        );
      }, done.fail);
    });
  });
});
