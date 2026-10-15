describe("template", function () {
  require("./setup")({ createTemplate: true });

  var drop = require("../index").drop;
  var setMetadata = require("../index").setMetadata;
  var getTemplateList = require("../index").getTemplateList;
  var client = require("models/client");
  var Blog = require("models/blog");
  var key = require("../key");
  var generateCdnUrl = require("../util/generateCdnUrl");

  it("drops a template", function (done) {
    drop(this.blog.id, this.template.name, done);
  });

  it("drop removes a template from the list of templates", function (done) {
    var test = this;
    getTemplateList(test.blog.id, function (err, templates) {
      if (err) return done.fail(err);
      expect(templates).toContain(test.template);
      drop(test.blog.id, test.template.name, function (err) {
        if (err) return done.fail(err);
        getTemplateList(test.blog.id, function (err, templates) {
          if (err) return done.fail(err);
          expect(templates).not.toContain(test.template);
          done();
        });
      });
    });
  });

  it("drop removes the URL key for a view in the template", function (done) {
    var test = this;
    var view = {
      name: "notes.txt",
      content: "Notes content",
      url: "/notes",
    };

    require("../index").setView(test.template.id, view, function (err) {
      if (err) return done.fail(err);
      drop(test.blog.id, test.template.name, function (err) {
        if (err) return done.fail(err);
        client.keys("*" + test.template.id + "*").then(function (result) {
          expect(result).toEqual([]);
          done();
        }).catch(done.fail);
      });
    });
  });

  it("drop removes all keys for the template", function (done) {
    var test = this;
    drop(test.blog.id, test.template.name, function (err) {
      if (err) return done.fail(err);
      client.keys("*" + test.template.id + "*").then(function (result) {
        expect(result).toEqual([]);
        done();
      }).catch(done.fail);
    });
  });

  it("updates the cache ID of the blog which owns a template after dropping", function (done) {
    var test = this;
    var initialCacheID = test.blog.cacheID;
    drop(test.blog.id, test.template.name, function (err) {
      if (err) return done.fail(err);
      Blog.get({ id: test.template.owner }, function (err, blog) {
        if (err) return done.fail(err);
        expect(blog.cacheID).not.toEqual(initialCacheID);
        done();
      });
    });
  });

  it("cleans up references when metadata is missing", function (done) {
    var test = this;

    client.del(key.metadata(test.template.id)).then(function () {

      drop(test.blog.id, test.template.name, function (err) {
        if (err) return done.fail(err);

        client
          .sIsMember(key.blogTemplates(test.blog.id), test.template.id)
          .then(function (isMember) {
            expect(!!isMember).toBe(false);
            done();
          })
          .catch(done.fail);
      });
    }).catch(done.fail);
  });

  it("drop resolves without an error when the template does not exist", function (done) {
    var test = this;
    drop(test.blog.id, "nonexistent-template", function (err, message) {
      if (err) return done.fail(err);
      expect(typeof message).toBe("string");
      done();
    });
  });

  it("removes rendered output Redis keys from CDN manifest entries", function (done) {
    var test = this;
    var manifest = {
      "assets/style.css": "a1b2c3d4e5f6a7b8",
      "partials/header.html": "b1c2d3e4f5a6b7c8",
    };

    Promise.all(
      Object.keys(manifest).map(function (target) {
        var hash = manifest[target];
        var renderedKey = key.renderedOutput(hash);
        return client.set(renderedKey, "rendered");
      })
    )
      .then(function () {
        return new Promise(function (resolve, reject) {
          setMetadata(test.template.id, { cdn: manifest }, function (err) {
            if (err) return reject(err);
            resolve();
          });
        });
      })
      .then(function () {
        return new Promise(function (resolve, reject) {
          drop(test.blog.id, test.template.name, function (err) {
            if (err) return reject(err);
            resolve();
          });
        });
      })
      .then(function () {
        return Promise.all(
          Object.keys(manifest).map(function (target) {
            var hash = manifest[target];
            var renderedKey = key.renderedOutput(hash);

            return client.get(renderedKey).then(function (result) {
              expect(result).toBeNull();
            });
          })
        );
      })
      .then(function () {
        done();
      })
      .catch(done.fail);
  });

  it("purges CDN URLs from metadata manifest entries when dropping a template", function (done) {
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
    var purgeSpy = jasmine.createSpy("purgeCdnUrls").and.returnValue(Promise.resolve());

    require.cache[purgePath] = {
      id: purgePath,
      filename: purgePath,
      loaded: true,
      exports: purgeSpy,
    };
    delete require.cache[dropPath];
    var dropWithPurgeStub = require("../drop");

    new Promise(function (resolve, reject) {
      client.hSet(metadataKey, "cdn", JSON.stringify(manifest)).then(resolve, reject);
    })
      .then(function () {
        return new Promise(function (resolve, reject) {
          client.hGet(metadataKey, "cdn").then(function (rawCdn) {
            expect(JSON.parse(rawCdn)).toEqual(manifest);
            resolve();
          }, reject);
        });
      })
      .then(function () {
        return new Promise(function (resolve, reject) {
          dropWithPurgeStub(test.blog.id, test.template.name, function (err) {
            if (err) return reject(err);
            resolve();
          });
        });
      })
      .then(function () {
        var expectedUrls = Object.keys(manifest).map(function (target) {
          return generateCdnUrl(target, manifest[target]);
        });
        expect(purgeSpy).toHaveBeenCalledTimes(1);
        expect(purgeSpy).toHaveBeenCalledWith(expectedUrls);
      })
      .then(function () {
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
        done();
      })
      .catch(function (err) {
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

        done.fail(err);
      });
  });

  it("still drops when metadata.cdn is missing or malformed", function (done) {
    var test = this;
    var metadataKey = key.metadata(test.template.id);

    client.hDel(metadataKey, "cdn").then(function () {

      drop(test.blog.id, test.template.name, function (err) {
        if (err) return done.fail(err);

        require("../index").create(test.blog.id, "malformed-cdn", {}, function (err) {
          if (err) return done.fail(err);

          var malformedTemplateID = test.blog.id + ":malformed-cdn";
          client
            .hSet(key.metadata(malformedTemplateID), "cdn", '"broken"')
            .then(function () {
              drop(test.blog.id, "malformed-cdn", function (err, message) {
                if (err) return done.fail(err);
                expect(typeof message).toBe("string");
                done();
              });
            })
            .catch(done.fail);
        });
      });
    }).catch(done.fail);
  });
});
