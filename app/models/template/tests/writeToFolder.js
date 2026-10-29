var fs = require("fs-extra");
var join = require("path").join;
var clients = require("clients");

describe("template", function () {
var writeToFolder = require("../index").writeToFolder;
var setView = require("../index").setView;
var dropView = require("../index").dropView;
var setMetadata = require("../index").setMetadata;
var packageAPI = require("../index").package;
var removeEnabledFromAllTemplates = require("../index").removeEnabledFromAllTemplates;
var writeChangeToFolder = require("../../../dashboard/site/template/save/writeChangeToFolder");

  require("./setup")({ createTemplate: true });

  afterEach(function () {
    fs.removeSync(this.blogDirectory + "/Templates");
    fs.removeSync(this.blogDirectory + "/templates");
    fs.removeSync(this.blogDirectory + "/posts");
    fs.removeSync(this.blogDirectory + "/drafts");
  });

  it("writes a template to a folder", function (done) {
    var test = this;
    var view = {
      name: "post.html",
      content: "<h1>Post content</h1>",
    };

    setView(this.template.id, view, function (err) {
      if (err) return done.fail(err);

      writeToFolder(test.blog.id, test.template.id, function (err) {
        if (err) return done.fail(err);
        var upperPath =
          test.blogDirectory +
          "/Templates/" +
          test.template.slug +
          "/" +
          view.name;
        var lowerPath =
          test.blogDirectory +
          "/templates/" +
          test.template.slug +
          "/" +
          view.name;
        var targetPath = fs.existsSync(upperPath) ? upperPath : lowerPath;
        expect(fs.readFileSync(targetPath, "utf-8")).toEqual(view.content);
        if (targetPath === upperPath) {
          expect(fs.existsSync(test.blogDirectory + "/templates")).toEqual(
            false
          );
        } else {
          expect(fs.existsSync(test.blogDirectory + "/Templates")).toEqual(
            false
          );
        }
        done();
      });
    });
  });

  it("writes template metadata to package.json in a folder", function (done) {
    var test = this;
    var metadata = { locals: { foo: "bar" } };

    setMetadata(this.template.id, metadata, function (err) {
      if (err) return done.fail(err);

      writeToFolder(test.blog.id, test.template.id, function (err) {
        if (err) return done.fail(err);
        var upperPath =
          test.blogDirectory +
          "/Templates/" +
          test.template.slug +
          "/package.json";
        var lowerPath =
          test.blogDirectory +
          "/templates/" +
          test.template.slug +
          "/package.json";
        var targetPath = fs.existsSync(upperPath) ? upperPath : lowerPath;
        expect(fs.readJsonSync(targetPath).locals).toEqual(metadata.locals);
        done();
      });
    });
  });

  it("removeEnabledFromAllTemplates disables all templates with enabled: true", function (done) {
    var test = this;
    var templatesRoot = join(test.blogDirectory, "Templates");
    var template1Dir = join(templatesRoot, "template-1");
    var template2Dir = join(templatesRoot, "template-2");
    var template3Dir = join(templatesRoot, "template-3");
    var package1 = JSON.stringify({ name: "Template 1", enabled: true }, null, 2);
    var package2 = JSON.stringify({ name: "Template 2", enabled: true }, null, 2);
    var package3 = JSON.stringify({ name: "Template 3", enabled: false }, null, 2);

    fs.ensureDirSync(template1Dir);
    fs.ensureDirSync(template2Dir);
    fs.ensureDirSync(template3Dir);
    fs.outputFileSync(join(template1Dir, "package.json"), package1);
    fs.outputFileSync(join(template2Dir, "package.json"), package2);
    fs.outputFileSync(join(template3Dir, "package.json"), package3);

    removeEnabledFromAllTemplates(test.blog.id, function (err, modifiedSlugs) {
      if (err) return done.fail(err);
      
      // Templates with enabled: true should be disabled
      expect(
        fs.readJsonSync(join(template1Dir, "package.json")).enabled
      ).toEqual(false);
      expect(
        fs.readJsonSync(join(template2Dir, "package.json")).enabled
      ).toEqual(false);
      
      // Templates with enabled: false should remain unchanged
      expect(
        fs.readJsonSync(join(template3Dir, "package.json")).enabled
      ).toEqual(false);
      
      // Should return the slugs of modified templates
      expect(Array.isArray(modifiedSlugs)).toBe(true);
      expect(modifiedSlugs.length).toBe(2);
      expect(modifiedSlugs).toContain("template-1");
      expect(modifiedSlugs).toContain("template-2");
      
      done();
    });
  });

  it("regenerates package.json in the local folder when local editing is enabled via package save", function (done) {
    var test = this;
    var packageMetadata = { localEditing: true, name: "Local Package" };
    var staleTemplate = Object.assign({}, this.template, { localEditing: false });

    packageAPI.save(this.template.id, packageMetadata, function (err) {
      if (err) return done.fail(err);

      writeChangeToFolder(
        test.blog,
        staleTemplate,
        { name: "package.json" },
        function (err) {
          if (err) return done.fail(err);

          var packagePath = getTemplatePath(test, "package.json");
          expect(fs.readJsonSync(packagePath).name).toEqual(packageMetadata.name);
          done();
        }
      );
    });
  });

  it("writes view metadata to package.json to a folder", function (done) {
    var test = this;
    var view = {
      name: "about.html",
      content: "<h1>About page</h1>",
      locals: { foo: "bar" },
    };

    setView(this.template.id, view, function (err) {
      if (err) return done.fail(err);

      writeToFolder(test.blog.id, test.template.id, function (err) {
        if (err) return done.fail(err);
        var upperPath =
          test.blogDirectory +
          "/Templates/" +
          test.template.slug +
          "/package.json";
        var lowerPath =
          test.blogDirectory +
          "/templates/" +
          test.template.slug +
          "/package.json";
        var targetPath = fs.existsSync(upperPath) ? upperPath : lowerPath;
        expect(fs.readJsonSync(targetPath).views[view.name].locals).toEqual(
          view.locals
        );
        done();
      });
    });
  });

  it("reuses an existing lowercase templates directory", function (done) {
    var test = this;
    var view = {
      name: "welcome.html",
      content: "<h1>Welcome</h1>",
    };
    var lowercaseBase = test.blogDirectory + "/templates";
    var expectedPath =
      lowercaseBase + "/" + test.template.slug + "/" + view.name;

    fs.ensureDirSync(lowercaseBase);

    setView(this.template.id, view, function (err) {
      if (err) return done.fail(err);

      writeToFolder(test.blog.id, test.template.id, function (err) {
        if (err) return done.fail(err);

        expect(fs.readFileSync(expectedPath, "utf-8")).toEqual(view.content);
        expect(fs.existsSync(test.blogDirectory + "/Templates")).toEqual(false);
        done();
      });
    });
  });

  it("creates lowercase templates when root entries are lowercase", function (done) {
    var test = this;
    var view = {
      name: "lowercase.html",
      content: "<h1>Lowercase template</h1>",
    };
    var posts = test.blogDirectory + "/posts";
    var drafts = test.blogDirectory + "/drafts";
    var lowercasePath =
      test.blogDirectory + "/templates/" + test.template.slug + "/" + view.name;

    fs.ensureDirSync(posts);
    fs.ensureDirSync(drafts);

    setView(this.template.id, view, function (err) {
      if (err) return done.fail(err);

      writeToFolder(test.blog.id, test.template.id, function (err) {
        if (err) {
          fs.removeSync(posts);
          fs.removeSync(drafts);
          return done.fail(err);
        }

        try {
          expect(fs.readFileSync(lowercasePath, "utf-8")).toEqual(view.content);
          expect(fs.existsSync(test.blogDirectory + "/Templates")).toEqual(
            false
          );
        } catch (assertErr) {
          fs.removeSync(posts);
          fs.removeSync(drafts);
          return done.fail(assertErr);
        }

        fs.removeSync(posts);
        fs.removeSync(drafts);
        done();
      });
    });
  });

  it("skips rewriting files when contents have not changed", function (done) {
    var test = this;
    var view = {
      name: "static.html",
      content: "<h1>Static content</h1>",
    };

    setView(this.template.id, view, function (err) {
      if (err) return done.fail(err);

      writeToFolder(test.blog.id, test.template.id, function (err) {
        if (err) return done.fail(err);

        var targetPath = getTemplatePath(test, view.name);
        var originalStat = fs.statSync(targetPath);

        writeToFolder(test.blog.id, test.template.id, function (err) {
          if (err) return done.fail(err);

          var updatedStat = fs.statSync(targetPath);
          expect(updatedStat.mtimeMs).toEqual(originalStat.mtimeMs);
          done();
        });
      });
    });
  });

  it("removes orphaned files left in the template directory", function (done) {
    var test = this;
    var view = {
      name: "clean.html",
      content: "<h1>Clean template</h1>",
    };

    setView(this.template.id, view, function (err) {
      if (err) return done.fail(err);

      writeToFolder(test.blog.id, test.template.id, function (err) {
        if (err) return done.fail(err);

        var templateDir = getTemplateDir(test);
        var orphanPath = join(templateDir, "orphan.html");
        fs.outputFileSync(orphanPath, "orphan");

        writeToFolder(test.blog.id, test.template.id, function (err) {
          if (err) return done.fail(err);

          expect(fs.existsSync(orphanPath)).toEqual(false);
          expect(
            fs.readFileSync(join(templateDir, view.name), "utf-8")
          ).toEqual(view.content);
          done();
        });
      });
    });
  });

  it("removes orphans while preserving existing files with the local client", function (done) {
    var test = this;
    var view = {
      name: "local.html",
      content: "<h1>Local template</h1>",
    };

    this.blog
      .update({ client: "local" })
      .then(function () {
        setView(test.template.id, view, function (err) {
          if (err) return done.fail(err);

          writeToFolder(test.blog.id, test.template.id, function (err) {
            if (err) return done.fail(err);

            var templateDir = getTemplateDir(test);
            var viewPath = join(templateDir, view.name);
            var originalStat = fs.statSync(viewPath);
            var orphanPath = join(templateDir, "orphan.html");

            fs.outputFileSync(orphanPath, "orphan");

            writeToFolder(test.blog.id, test.template.id, function (err) {
              if (err) return done.fail(err);

              var rewrittenStat = fs.statSync(viewPath);

              expect(fs.existsSync(orphanPath)).toEqual(false);
              expect(rewrittenStat.mtimeMs).toEqual(originalStat.mtimeMs);
              expect(fs.readFileSync(viewPath, "utf-8")).toEqual(view.content);
              done();
            });
          });
        });
      })
      .catch(function (err) {
        done.fail(err);
      });
  });

  it("ignores symbolic links when scanning template files", function (done) {
    var test = this;
    var view = {
      name: "linked.html",
      content: "<h1>Linked template</h1>",
    };

    setView(this.template.id, view, function (err) {
      if (err) return done.fail(err);

      writeToFolder(test.blog.id, test.template.id, function (err) {
        if (err) return done.fail(err);

        var templateDir = getTemplateDir(test);
        var loopPath = join(templateDir, "loop");
        var orphanPath = join(templateDir, "orphan.html");

        try {
          fs.removeSync(loopPath);
        } catch (cleanupErr) {
          if (cleanupErr && cleanupErr.code !== "ENOENT") {
            return done.fail(cleanupErr);
          }
        }

        try {
          fs.ensureSymlinkSync(templateDir, loopPath, "dir");
        } catch (symlinkErr) {
          return done.fail(symlinkErr);
        }

        fs.outputFileSync(orphanPath, "orphan");

        writeToFolder(test.blog.id, test.template.id, function (err) {
          if (err) return done.fail(err);

          try {
            expect(fs.existsSync(orphanPath)).toEqual(false);
            expect(
              fs.readFileSync(join(templateDir, view.name), "utf-8")
            ).toEqual(view.content);

            var linkStat = fs.lstatSync(loopPath);
            expect(linkStat.isSymbolicLink()).toEqual(true);
          } catch (assertErr) {
            return done.fail(assertErr);
          }

          done();
        });
      });
    });
  });

  it("waits for the folder lock to be released before writing", async function () {
    var folderLock = require("sync/lock");
    var { promisify } = require("util");

    await promisify(setView)(this.template.id, {
      name: "post.html",
      content: "<h1>Locked</h1>",
    });

    var held = await folderLock.lock(this.blog.id, { ttl: 10000 });
    var released = false;

    setTimeout(function () {
      released = true;
      held.release();
    }, 1200);

    await promisify(writeToFolder)(this.blog.id, this.template.id);

    // The write only ran once the lock was free, and gave the lock back
    expect(released).toEqual(true);
    expect(fs.readFileSync(getTemplatePath(this, "post.html"), "utf-8")).toEqual(
      "<h1>Locked</h1>"
    );
    expect((await folderLock.inspect(this.blog.id)).held).toBeFalsy();
  });
});

function getTemplateDir(test) {
  var upperPath = test.blogDirectory + "/Templates/" + test.template.slug;
  var lowerPath = test.blogDirectory + "/templates/" + test.template.slug;

  return fs.existsSync(upperPath) ? upperPath : lowerPath;
}

function getTemplatePath(test, fileName) {
  var templateDir = getTemplateDir(test);
  return join(templateDir, fileName);
}
