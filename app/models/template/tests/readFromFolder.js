describe("template", function () {
  var folder = require("storage/folder");
  var get = require("../index").getView;

  var create = require("../index").create;
  var readFromFolder = require("../index").readFromFolder;
  var setView = require("../index").setView;
  var getViewByURL = require("../index").getViewByURL;

  require("./setup")({ createTemplate: true });

  beforeEach(async function () {
    var name = this.blog.handle;

    // readFromFolder takes a path in the blog's folder, which is removed
    // along with the blog
    this.dir = "/Templates/" + name;

    // Writes a file into the template's folder in the blog's folder
    this.put = (path, contents) =>
      folder.write(this.blog.id, this.dir + path, contents);

    await create(this.blog.id, name, { localEditing: true });
  });

  it("reads template properties from package.json", async function () {
    await this.put("/package.json", JSON.stringify({ locals: { foo: "bar" } }));

    var template = await readFromFolder(this.blog.id, this.dir);
    expect(template.locals.foo).toEqual("bar");
  });

  it("marks a template read from a folder without package.json as locally edited", async function () {
    var setMetadata = require("../index").setMetadata;
    var makeID = require("../util/makeID");
    var test = this;

    await this.put("/entries.html", "{{title}}");
    await setMetadata(makeID(test.blog.id, test.blog.handle), {
      localEditing: false,
    });

    var template = await readFromFolder(test.blog.id, test.dir);
    expect(template.localEditing).toEqual(true);
  });

  it("leaves the blog's cache alone when a sync reads an unchanged template", async function () {
    var { promisify } = require("util");
    var read = readFromFolder;
    var getMetadata = require("../index").getMetadata;
    var getBlog = (by) => require("models/blog").get(by);
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

  it("explains what is wrong with an invalid package.json", async function () {
    await this.put("/package.json", '{\n  "name": "Example",\n}');

    var template = await readFromFolder(this.blog.id, this.dir);
    var message = template.errors["package.json"];

    // The message has to describe the file, not our own failure to
    // rewrite the parse error
    expect(message).not.toContain("Cannot read properties");
    expect(message.toLowerCase()).toContain("json");
  });

  it("ignores view files which are too large", async function () {
    // 3mb of random data should exceed the limit of 2.5mb
    await this.put(
      "/style.css",
      require("crypto").randomBytes(3 * 1000 * 1000)
    );

    var template = await readFromFolder(this.blog.id, this.dir);
    var result = await getViewByURL(template.id, "/style.css");
    expect(result.viewName).toEqual(null);
  });

  it("reads a view's properties from package.json", async function () {
    await Promise.all([
      this.put("/style.css", "body {color:pink}"),
      this.put(
        "/package.json",
        JSON.stringify({
          locals: { foo: "bar" },
          views: { "style.css": { url: "/test", locals: { baz: "bat" } } },
        })
      ),
    ]);

    var template = await readFromFolder(this.blog.id, this.dir);
    var result = await getViewByURL(template.id, "/test");
    expect(result.viewName).toEqual("style.css");
  });

  it("assigns a view a URL automatically", async function () {
    await this.put("/style.css", "body {color:pink}");

    var template = await readFromFolder(this.blog.id, this.dir);
    var result = await getViewByURL(template.id, "/style.css");
    expect(result.viewName).toEqual("style.css");
  });

  // By default, when a new view is read from a template folder its URL
  // is set to its name, i.e. tags.html will be accessible at /tags.html
  // on the blog. It's possible to edit this URL/route on the template
  // editor. We want to preserve this URL if the template is ever read
  // from a folder in future.
  it("will not clobber the URL for a view set elsewhere", async function () {
    var templateFolder = this.dir;
    var blogID = this.blog.id;

    await this.put("/style.css", "body {color:pink}");
    var template = await readFromFolder(blogID, templateFolder);

    await setView(template.id, { name: "style.css", url: "/foo" });

    template = await readFromFolder(blogID, templateFolder);
    var result = await getViewByURL(template.id, "/foo");
    expect(result.viewName).toEqual("style.css");
  });

  it("removes a view when you remove its file", async function () {
    const dir = this.dir;
    const blogID = this.blog.id;

    await Promise.all([
      this.put("/hello.html", "Hello, world!"),
      this.put("/test.html", "Hello, test!"),
    ]);

    var template = await readFromFolder(blogID, dir);
    var view = await get(template.id, "test.html");
    expect(view.content).toEqual("Hello, test!");

    await folder.remove(blogID, dir + "/test.html");
    await readFromFolder(blogID, dir);

    var missing;
    try {
      missing = await get(template.id, "test.html");
      fail("should have thrown");
    } catch (err) {
      expect(err.message.includes("No view")).toBe(true);
      expect(missing).toEqual(undefined);
    }
  });

  it("reads a view's content from a folder", async function () {
    await this.put("/style.css", "body {color:pink}");

    var template = await readFromFolder(this.blog.id, this.dir);
    var view = await get(template.id, "style");
    expect(view.content).toEqual("body {color:pink}");
  });

  // A sync waits on buildFromFolder, which waits on this readFromFolder call,
  // before it releases the blog's folder lock. If an error (e.g. Redis
  // rejecting writes during a host cutover) never rejects the call the blog
  // can't sync again until the process restarts.
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

    it("passes an error creating a new template to the callback", async function () {
      var dir = this.dir + "/new-template";
      var error = redisError();
      var create = jasmine.createSpy("create").and.callFake(function () {
        return Promise.reject(error);
      });

      await folder.write(
        this.blog.id,
        dir + "/entries.html",
        "{{#entries}}{{/entries}}"
      );

      try {
        await readFromFolderWith({ create: create })(this.blog.id, dir);
        fail("should have thrown");
      } catch (err) {
        expect(create).toHaveBeenCalled();
        expect(err).toBe(error);
      }
    });

    it("passes an error reading the template's metadata to the callback", async function () {
      var error = redisError();
      var create = jasmine.createSpy("create");
      var getMetadata = function () {
        return Promise.reject(error);
      };

      await this.put("/style.css", "body {color:pink}");

      try {
        await readFromFolderWith({ create: create, getMetadata: getMetadata })(
          this.blog.id,
          this.dir
        );
        fail("should have thrown");
      } catch (err) {
        // Only a missing template should be created
        expect(create).not.toHaveBeenCalled();
        expect(err).toBe(error);
      }
    });

    it("passes an error saving the template's metadata to the callback", async function () {
      var error = redisError();
      var setMetadata = function () {
        return Promise.reject(error);
      };

      await this.put("/style.css", "body {color:pink}");

      try {
        await readFromFolderWith({ setMetadata: setMetadata })(
          this.blog.id,
          this.dir
        );
        fail("should have thrown");
      } catch (err) {
        expect(err).toBe(error);
      }
    });
  });
});
