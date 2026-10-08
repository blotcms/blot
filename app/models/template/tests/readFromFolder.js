describe("template", function () {
  var fs = require("fs-extra");
  var get = require("../index").getView;

  var create = require("../index").create;
  var readFromFolder = require("../index").readFromFolder;
  var setView = require("../index").setView;
  var getViewByURL = require("../index").getViewByURL;

  require("./setup")({ createTemplate: true });

  // Sets up a temporary tmp folder and cleans it up after
  global.test.tmp();

  beforeEach(function (done) {
    var name = require("path").basename(this.tmp);

    create(this.blog.id, name, { localEditing: true }, done);
  });

  it("reads template properties from package.json", function (done) {
    fs.outputJsonSync(this.tmp + "/package.json", {
      locals: { foo: "bar" }
    });

    readFromFolder(this.blog.id, this.tmp, function (err, template) {
      if (err) return done.fail(err);

      expect(template.locals.foo).toEqual("bar");
      done();
    });
  });

  it("explains what is wrong with an invalid package.json", function (done) {
    fs.outputFileSync(this.tmp + "/package.json", '{\n  "name": "Example",\n}');

    readFromFolder(this.blog.id, this.tmp, function (err, template) {
      if (err) return done.fail(err);

      var message = template.errors["package.json"];

      // The message has to describe the file, not our own failure to
      // rewrite the parse error
      expect(message).not.toContain("Cannot read properties");
      expect(message.toLowerCase()).toContain("json");
      done();
    });
  });

  it("ignores view files which are too large", function (done) {
    // 3mb of random data should exceed the limit of 2.5mb
    fs.writeFileSync(
      this.tmp + "/style.css",
      require("crypto").randomBytes(3 * 1000 * 1000)
    );

    readFromFolder(this.blog.id, this.tmp, function (err, template) {
      if (err) return done.fail(err);

      getViewByURL(template.id, "/style.css", function (err, name) {
        if (err) return done.fail(err);

        expect(name).toEqual(null);
        done();
      });
    });
  });

  it("reads a view's properties from package.json", function (done) {
    fs.outputFileSync(this.tmp + "/style.css", "body {color:pink}");
    fs.outputJsonSync(this.tmp + "/package.json", {
      locals: { foo: "bar" },
      views: { "style.css": { url: "/test", locals: { baz: "bat" } } }
    });

    readFromFolder(this.blog.id, this.tmp, function (err, template) {
      if (err) return done.fail(err);

      getViewByURL(template.id, "/test", function (err, name) {
        if (err) return done.fail(err);

        expect(name).toEqual("style.css");
        done();
      });
    });
  });

  it("assigns a view a URL automatically", function (done) {
    fs.outputFileSync(this.tmp + "/style.css", "body {color:pink}");

    readFromFolder(this.blog.id, this.tmp, function (err, template) {
      if (err) return done.fail(err);

      getViewByURL(template.id, "/style.css", function (err, name) {
        if (err) return done.fail(err);

        expect(name).toEqual("style.css");
        done();
      });
    });
  });

  // By default, when a new view is read from a template folder its URL
  // is set to its name, i.e. tags.html will be accessible at /tags.html
  // on the blog. It's possible to edit this URL/route on the template
  // editor. We want to preserve this URL if the template is ever read
  // from a folder in future.
  it("will not clobber the URL for a view set elsewhere", function (done) {
    fs.outputFileSync(this.tmp + "/style.css", "body {color:pink}");
    var templateFolder = this.tmp;
    var blogID = this.blog.id;

    readFromFolder(blogID, templateFolder, function (err, template) {
      if (err) return done.fail(err);

      setView(template.id, { name: "style.css", url: "/foo" }, function (err) {
        if (err) return done.fail(err);

        readFromFolder(blogID, templateFolder, function (err, template) {
          if (err) return done.fail(err);

          getViewByURL(template.id, "/foo", function (err, name) {
            if (err) return done.fail(err);

            expect(name).toEqual("style.css");
            done();
          });
        });
      });
    });
  });

  it("removes a view when you remove its file", function (done) {
    const tmp = this.tmp;
    const blogID = this.blog.id;

    fs.outputFileSync(tmp + "/hello.html", "Hello, world!");
    fs.outputFileSync(tmp + "/test.html", "Hello, test!");

    readFromFolder(blogID, tmp, function (err, template) {
      if (err) return done.fail(err);
      get(template.id, "test.html", function (err, view) {
        expect(view.content).toEqual("Hello, test!");

        fs.removeSync(tmp + "/test.html");
        readFromFolder(blogID, tmp, function (err) {
          if (err) return done.fail(err);
          get(template.id, "test.html", function (err, view) {
            expect(err.message.includes("No view")).toBe(true);
            expect(view).toEqual(undefined);
            done();
          });
        });
      });
    });
  });

  it("reads a view's content from a folder", function (done) {
    fs.outputFileSync(this.tmp + "/style.css", "body {color:pink}");

    readFromFolder(this.blog.id, this.tmp, function (err, template) {
      if (err) return done.fail(err);

      get(template.id, "style", function (err, view) {
        if (err) return done.fail(err);
        expect(view.content).toEqual("body {color:pink}");
        done();
      });
    });
  });

  // A sync waits on buildFromFolder, which waits on this callback, before it
  // releases the blog's folder lock. If an error (e.g. Redis rejecting writes
  // during a host cutover) never reaches the callback the blog can't sync
  // again until the process restarts.
  describe("when Redis fails", function () {
    var originals = {};

    function readFromFolderWith (stubs) {
      Object.keys(stubs).forEach(function (name) {
        var path = require.resolve("../" + name);
        originals[path] = require.cache[path];
        require.cache[path] = {
          id: path,
          filename: path,
          loaded: true,
          exports: stubs[name]
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

    function redisError () {
      return new Error("NOREPLICAS Not enough good replicas to write.");
    }

    // Fails the spec if the callback fires more than once
    function once (done, check) {
      var calls = 0;
      return function () {
        if (++calls > 1) return done.fail(new Error("Callback invoked twice"));
        check.apply(null, arguments);
        setTimeout(done, 100);
      };
    }

    it("passes an error creating a new template to the callback", function (done) {
      var dir = this.tmp + "/new-template";
      var error = redisError();
      var create = jasmine.createSpy("create").and.callFake(function (
        owner,
        name,
        metadata,
        callback
      ) {
        callback(error);
      });

      fs.outputFileSync(dir + "/entries.html", "{{#entries}}{{/entries}}");

      readFromFolderWith({ create: create })(
        this.blog.id,
        dir,
        once(done, function (err) {
          expect(create).toHaveBeenCalled();
          expect(err).toBe(error);
        })
      );
    });

    it("passes an error reading the template's metadata to the callback", function (done) {
      var error = redisError();
      var create = jasmine.createSpy("create");
      var getMetadata = function (id, callback) {
        callback(error);
      };

      fs.outputFileSync(this.tmp + "/style.css", "body {color:pink}");

      readFromFolderWith({ create: create, getMetadata: getMetadata })(
        this.blog.id,
        this.tmp,
        once(done, function (err) {
          // Only a missing template should be created
          expect(create).not.toHaveBeenCalled();
          expect(err).toBe(error);
        })
      );
    });

    it("passes an error saving the template's metadata to the callback", function (done) {
      var error = redisError();
      var setMetadata = function (id, updates, callback) {
        callback(error);
      };

      fs.outputFileSync(this.tmp + "/style.css", "body {color:pink}");

      readFromFolderWith({ setMetadata: setMetadata })(
        this.blog.id,
        this.tmp,
        once(done, function (err) {
          expect(err).toBe(error);
        })
      );
    });
  });
});
