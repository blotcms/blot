var folder = require("storage/folder");
var join = require("path").posix.join;
require("clients");

describe("template", function () {
  var writeToFolder = require("../index").writeToFolder;
  var setView = require("../index").setView;
  var setMetadata = require("../index").setMetadata;
  var packageAPI = require("../index").package;
  var removeEnabledFromAllTemplates =
    require("../index").removeEnabledFromAllTemplates;
  var writeChangeToFolder = require("../../../dashboard/site/template/save/writeChangeToFolder");

  require("./setup")({ createTemplate: true });

  afterEach(async function () {
    await folder.remove(this.blog.id, "/Templates");
    await folder.remove(this.blog.id, "/templates");
    await folder.remove(this.blog.id, "/posts");
    await folder.remove(this.blog.id, "/drafts");
  });

  it("writes a template to a folder", async function () {
    var test = this;
    var view = {
      name: "post.html",
      content: "<h1>Post content</h1>",
    };

    await setView(this.template.id, view);
    await writeToFolder(test.blog.id, test.template.id);

    var upperPath = "/Templates/" + test.template.slug + "/" + view.name;
    var lowerPath = "/templates/" + test.template.slug + "/" + view.name;
    var targetPath = (await exists(test, upperPath)) ? upperPath : lowerPath;

    expect(await readText(test, targetPath)).toEqual(view.content);

    if (targetPath === upperPath) {
      expect(await exists(test, "/templates")).toEqual(false);
    } else {
      expect(await exists(test, "/Templates")).toEqual(false);
    }
  });

  it("writes template metadata to package.json in a folder", async function () {
    var test = this;
    var metadata = { locals: { foo: "bar" } };

    await setMetadata(this.template.id, metadata);
    await writeToFolder(test.blog.id, test.template.id);

    var targetPath = await getTemplatePath(test, "package.json");

    expect(JSON.parse(await readText(test, targetPath)).locals).toEqual(
      metadata.locals
    );
  });

  it("removeEnabledFromAllTemplates disables all templates with enabled: true", async function () {
    var test = this;
    var templatesRoot = "/Templates";
    var template1Dir = join(templatesRoot, "template-1");
    var template2Dir = join(templatesRoot, "template-2");
    var template3Dir = join(templatesRoot, "template-3");
    var package1 = JSON.stringify(
      { name: "Template 1", enabled: true },
      null,
      2
    );
    var package2 = JSON.stringify(
      { name: "Template 2", enabled: true },
      null,
      2
    );
    var package3 = JSON.stringify(
      { name: "Template 3", enabled: false },
      null,
      2
    );

    await folder.write(
      test.blog.id,
      join(template1Dir, "package.json"),
      package1
    );
    await folder.write(
      test.blog.id,
      join(template2Dir, "package.json"),
      package2
    );
    await folder.write(
      test.blog.id,
      join(template3Dir, "package.json"),
      package3
    );

    var modifiedSlugs = await removeEnabledFromAllTemplates(test.blog.id);

    // Templates with enabled: true should be disabled
    expect(
      JSON.parse(await readText(test, join(template1Dir, "package.json")))
        .enabled
    ).toEqual(false);
    expect(
      JSON.parse(await readText(test, join(template2Dir, "package.json")))
        .enabled
    ).toEqual(false);

    // Templates with enabled: false should remain unchanged
    expect(
      JSON.parse(await readText(test, join(template3Dir, "package.json")))
        .enabled
    ).toEqual(false);

    // Should return the slugs of modified templates
    expect(Array.isArray(modifiedSlugs)).toBe(true);
    expect(modifiedSlugs.length).toBe(2);
    expect(modifiedSlugs).toContain("template-1");
    expect(modifiedSlugs).toContain("template-2");
  });

  it("regenerates package.json in the local folder when local editing is enabled via package save", async function () {
    var test = this;
    var packageMetadata = { localEditing: true, name: "Local Package" };
    var staleTemplate = Object.assign({}, this.template, {
      localEditing: false,
    });

    await packageAPI.save(this.template.id, packageMetadata);
    await writeChangeToFolder(test.blog, staleTemplate, {
      name: "package.json",
    });

    var packagePath = await getTemplatePath(test, "package.json");
    expect(JSON.parse(await readText(test, packagePath)).name).toEqual(
      packageMetadata.name
    );
  });

  it("writes view metadata to package.json to a folder", async function () {
    var test = this;
    var view = {
      name: "about.html",
      content: "<h1>About page</h1>",
      locals: { foo: "bar" },
    };

    await setView(this.template.id, view);
    await writeToFolder(test.blog.id, test.template.id);

    var targetPath = await getTemplatePath(test, "package.json");

    expect(
      JSON.parse(await readText(test, targetPath)).views[view.name].locals
    ).toEqual(view.locals);
  });

  it("reuses an existing lowercase templates directory", async function () {
    var test = this;
    var view = {
      name: "welcome.html",
      content: "<h1>Welcome</h1>",
    };
    var lowercaseBase = "/templates";
    var expectedPath =
      lowercaseBase + "/" + test.template.slug + "/" + view.name;

    await folder.mkdir(test.blog.id, lowercaseBase);

    await setView(this.template.id, view);
    await writeToFolder(test.blog.id, test.template.id);

    expect(await readText(test, expectedPath)).toEqual(view.content);
    expect(await exists(test, "/Templates")).toEqual(false);
  });

  it("creates lowercase templates when root entries are lowercase", async function () {
    var test = this;
    var view = {
      name: "lowercase.html",
      content: "<h1>Lowercase template</h1>",
    };
    var lowercasePath = "/templates/" + test.template.slug + "/" + view.name;

    await folder.mkdir(test.blog.id, "/posts");
    await folder.mkdir(test.blog.id, "/drafts");

    await setView(this.template.id, view);
    await writeToFolder(test.blog.id, test.template.id);

    expect(await readText(test, lowercasePath)).toEqual(view.content);
    expect(await exists(test, "/Templates")).toEqual(false);
  });

  it("skips rewriting files when contents have not changed", async function () {
    var test = this;
    var view = {
      name: "static.html",
      content: "<h1>Static content</h1>",
    };

    await setView(this.template.id, view);
    await writeToFolder(test.blog.id, test.template.id);

    var targetPath = await getTemplatePath(test, view.name);
    var originalStat = await folder.stat(test.blog.id, targetPath);

    await writeToFolder(test.blog.id, test.template.id);

    var updatedStat = await folder.stat(test.blog.id, targetPath);
    expect(updatedStat.modified).toEqual(originalStat.modified);
  });

  it("removes orphaned files left in the template directory", async function () {
    var test = this;
    var view = {
      name: "clean.html",
      content: "<h1>Clean template</h1>",
    };

    await setView(this.template.id, view);
    await writeToFolder(test.blog.id, test.template.id);

    var templateDir = await getTemplateDir(test);
    var orphanPath = join(templateDir, "orphan.html");
    await folder.write(test.blog.id, orphanPath, "orphan");

    await writeToFolder(test.blog.id, test.template.id);

    expect(await exists(test, orphanPath)).toEqual(false);
    expect(await readText(test, join(templateDir, view.name))).toEqual(
      view.content
    );
  });

  it("leaves a file with a backslash in its name, which can't be a view", async function () {
    var test = this;

    await writeToFolder(test.blog.id, test.template.id);

    var filePath = join(await getTemplateDir(test), "notes\\backup.txt");
    await folder.write(test.blog.id, filePath, "keep");

    await writeToFolder(test.blog.id, test.template.id);

    expect(await exists(test, filePath)).toEqual(true);
  });

  it("removes orphans while preserving existing files with the local client", async function () {
    var test = this;
    var view = {
      name: "local.html",
      content: "<h1>Local template</h1>",
    };

    await this.blog.update({ client: "local" });
    await setView(test.template.id, view);
    await writeToFolder(test.blog.id, test.template.id);

    var templateDir = await getTemplateDir(test);
    var viewPath = join(templateDir, view.name);
    var originalStat = await folder.stat(test.blog.id, viewPath);
    var orphanPath = join(templateDir, "orphan.html");

    await folder.write(test.blog.id, orphanPath, "orphan");

    await writeToFolder(test.blog.id, test.template.id);

    var rewrittenStat = await folder.stat(test.blog.id, viewPath);

    expect(await exists(test, orphanPath)).toEqual(false);
    expect(rewrittenStat.modified).toEqual(originalStat.modified);
    expect(await readText(test, viewPath)).toEqual(view.content);
  });

  it("waits for the folder lock to be released before writing", async function () {
    var folderLock = require("sync/lock");

    await setView(this.template.id, {
      name: "post.html",
      content: "<h1>Locked</h1>",
    });

    var held = await folderLock.lock(this.blog.id, { ttl: 10000 });
    var released = false;

    setTimeout(function () {
      released = true;
      held.release();
    }, 1200);

    await writeToFolder(this.blog.id, this.template.id);

    // The write only ran once the lock was free, and gave the lock back
    expect(released).toEqual(true);
    expect(
      await readText(this, await getTemplatePath(this, "post.html"))
    ).toEqual("<h1>Locked</h1>");
    expect((await folderLock.inspect(this.blog.id)).held).toBeFalsy();
  });

  it("releases the lock if the client left while the request waited for it", async function () {
    var folderLock = require("sync/lock");
    var { holdForRequest } = require("../withFolderLock");
    var EventEmitter = require("events");
    var blogID = this.blog.id;
    var res = new EventEmitter();
    var nextCalled = false;

    var held = await folderLock.lock(blogID, { ttl: 10000 });

    holdForRequest({ blog: { id: blogID } }, res, function () {
      nextCalled = true;
    });

    // Client cancels while waiting, then the lock frees up
    res.emit("close");
    await held.release();
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(nextCalled).toEqual(false);
    expect((await folderLock.inspect(blogID)).held).toBeFalsy();
  });

  it("does not lock again inside a request that already holds the lock", async function () {
    var folderLock = require("sync/lock");
    var { holdForRequest } = require("../withFolderLock");
    var EventEmitter = require("events");
    var blogID = this.blog.id;
    var templateID = this.template.id;
    var res = new EventEmitter();

    await setView(this.template.id, {
      name: "post.html",
      content: "<h1>Held</h1>",
    });

    // Written inside the hold, the lock is already ours so this must not
    // wait for it (which would never be released) or release it early
    await new Promise(function (resolve, reject) {
      holdForRequest({ blog: { id: blogID } }, res, function (err) {
        if (err) return reject(err);

        writeToFolder(blogID, templateID)
          .then(function () {
            return folderLock.inspect(blogID);
          })
          .then(function (state) {
            expect(state.held).toEqual(true);
            res.emit("finish");
            resolve();
          })
          .catch(reject);
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await readText(this, await getTemplatePath(this, "post.html"))
    ).toEqual("<h1>Held</h1>");
    expect((await folderLock.inspect(blogID)).held).toBeFalsy();
  });
});

// Blog paths, in the blog's folder: the templates directory is "Templates"
// unless the folder already has a lowercase "templates"
async function getTemplateDir(test) {
  var upperPath = "/Templates/" + test.template.slug;
  var lowerPath = "/templates/" + test.template.slug;

  return (await exists(test, upperPath)) ? upperPath : lowerPath;
}

async function getTemplatePath(test, fileName) {
  var templateDir = await getTemplateDir(test);
  return join(templateDir, fileName);
}

function exists(test, path) {
  return folder.exists(test.blog.id, path);
}

async function readText(test, path) {
  return (await folder.read(test.blog.id, path)).toString();
}
