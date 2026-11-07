describe("template", function () {
  const { promisify } = require("util");
  require("./setup")({ createTemplate: true });

  var drop = require("../index").drop;
  var setMetadata = require("../index").setMetadata;
  var getTemplateList = require("../index").getTemplateList;
  var client = require("models/client");
  var Blog = require("models/blog");
  var key = require("../key");
  var generateCdnUrl = require("../util/generateCdnUrl");

  var blogGet = (by) => Blog.get(by);
  var blogSet = promisify(Blog.set);

  it("drops a template", async function () {
    await drop(this.blog.id, this.template.name);
  });

  it("drop removes a template from the list of templates", async function () {
    var test = this;
    const templates = await getTemplateList(test.blog.id);
    expect(templates).toContain(test.template);
    await drop(test.blog.id, test.template.name);
    const remaining = await getTemplateList(test.blog.id);
    expect(remaining).not.toContain(test.template);
  });

  it("drop removes the URL key for a view in the template", async function () {
    var test = this;
    var view = {
      name: "notes.txt",
      content: "Notes content",
      url: "/notes",
    };

    await require("../index").setView(test.template.id, view);
    await drop(test.blog.id, test.template.name);
    const result = await client.keys("*" + test.template.id + "*");
    expect(result).toEqual([]);
  });

  it("drop removes all keys for the template", async function () {
    var test = this;
    await drop(test.blog.id, test.template.name);
    const result = await client.keys("*" + test.template.id + "*");
    expect(result).toEqual([]);
  });

  it("updates the cache ID of the blog which has the template installed after dropping", async function () {
    var test = this;
    await blogSet(test.blog.id, { template: test.template.id });
    const installed = await blogGet({ id: test.blog.id });
    await drop(test.blog.id, test.template.name);
    const blog = await blogGet({ id: test.template.owner });
    expect(blog.cacheID).not.toEqual(installed.cacheID);
  });

  it("leaves the owner blog's cache ID alone when dropping a template it doesn't use", async function () {
    var test = this;
    const before = await blogGet({ id: test.blog.id });
    await drop(test.blog.id, test.template.name);
    const blog = await blogGet({ id: test.blog.id });
    expect(blog.cacheID).toEqual(before.cacheID);
  });

  it("cleans up references when metadata is missing", async function () {
    var test = this;

    await client.del(key.metadata(test.template.id));
    await drop(test.blog.id, test.template.name);
    const isMember = await client.sIsMember(
      key.blogTemplates(test.blog.id),
      test.template.id
    );
    expect(!!isMember).toBe(false);
  });

  it("drop resolves without an error when the template does not exist", async function () {
    var test = this;
    const message = await drop(test.blog.id, "nonexistent-template");
    expect(typeof message).toBe("string");
  });

  it("removes rendered output Redis keys from CDN manifest entries", async function () {
    var test = this;
    var manifest = {
      "assets/style.css": "a1b2c3d4e5f6a7b8",
      "partials/header.html": "b1c2d3e4f5a6b7c8",
    };

    await Promise.all(
      Object.keys(manifest).map(function (target) {
        var hash = manifest[target];
        var renderedKey = key.renderedOutput(hash);
        return client.set(renderedKey, "rendered");
      })
    );
    await setMetadata(test.template.id, { cdn: manifest });
    await drop(test.blog.id, test.template.name);
    await Promise.all(
      Object.keys(manifest).map(async function (target) {
        var hash = manifest[target];
        var renderedKey = key.renderedOutput(hash);
        const result = await client.get(renderedKey);
        expect(result).toBeNull();
      })
    );
  });

  it("purges CDN URLs from metadata manifest entries when dropping a template", async function () {
    var test = this;
    var manifest = {
      "assets/style.css": "d1e2f3a4b5c6d7e8",
      "partials/footer.html": "e1f2a3b4c5d6e7f8",
    };
    var metadataKey = key.metadata(test.template.id);
    var purgePath = require.resolve("helper/purgeCdnUrls");
    var dropPath = require.resolve("../drop");
    var originalPurgeModule = require.cache[purgePath];
    var originalDropModule = require.cache[dropPath];
    var purgeSpy = jasmine
      .createSpy("purgeCdnUrls")
      .and.returnValue(Promise.resolve());

    require.cache[purgePath] = {
      id: purgePath,
      filename: purgePath,
      loaded: true,
      exports: purgeSpy,
    };
    delete require.cache[dropPath];
    var dropWithPurgeStub = require("../drop");

    try {
      await client.hSet(metadataKey, "cdn", JSON.stringify(manifest));
      const rawCdn = await client.hGet(metadataKey, "cdn");
      expect(JSON.parse(rawCdn)).toEqual(manifest);

      await dropWithPurgeStub(test.blog.id, test.template.name);

      var expectedUrls = Object.keys(manifest).map(function (target) {
        return generateCdnUrl(target, manifest[target]);
      });
      expect(purgeSpy).toHaveBeenCalledTimes(1);
      expect(purgeSpy).toHaveBeenCalledWith(expectedUrls);
    } finally {
      if (originalPurgeModule) {
        require.cache[purgePath] = originalPurgeModule;
      } else {
        delete require.cache[purgePath];
      }

      if (originalDropModule) {
        require.cache[dropPath] = originalDropModule;
      } else {
        delete require.cache[dropPath];
      }
    }
  });

  it("still drops when metadata.cdn is missing or malformed", async function () {
    var test = this;
    var metadataKey = key.metadata(test.template.id);

    await client.hDel(metadataKey, "cdn");
    await drop(test.blog.id, test.template.name);
    await require("../index").create(test.blog.id, "malformed-cdn", {});

    var malformedTemplateID = test.blog.id + ":malformed-cdn";
    await client.hSet(key.metadata(malformedTemplateID), "cdn", '"broken"');
    const message = await drop(test.blog.id, "malformed-cdn");
    expect(typeof message).toBe("string");
  });
});
