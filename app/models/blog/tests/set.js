describe("Blog.set", function () {
  var set = require("../set");
  var get = require("../get");
  var key = require("../key");
  var client = require("models/client");
  var config = require("config");

  global.test.blog();

  it("will set the domain", function (done) {
    var test = this;
    var domain = "example.com";

    set(test.blog.id, { domain: domain }, function (err) {
      if (err) return done.fail(err);

      done();
    });
  });

  it("disables image metadata when turned off", function (done) {
    var test = this;

    set(test.blog.id, { imageExif: "off" }, function (errors) {
      if (errors) return done.fail(errors);

      get({ id: test.blog.id }, function (err, blog) {
        if (err) return done.fail(err);

        expect(blog.imageExif).toBe("off");
        expect(blog.isImageExifOff).toBe(true);
        expect(blog.isImageExifBasic).toBe(false);
        done();
      });
    });
  });

  it("saves full image metadata preference", function (done) {
    var test = this;

    set(test.blog.id, { imageExif: "full" }, function (errors) {
      if (errors) return done.fail(errors);

      get({ id: test.blog.id }, function (err, blog) {
        if (err) return done.fail(err);

        expect(blog.imageExif).toBe("full");
        expect(blog.isImageExifFull).toBe(true);
        expect(blog.isImageExifOff).toBe(false);
        done();
      });
    });
  });

  it("normalizes converter preferences", function (done) {
    var test = this;

    set(
      test.blog.id,
      { converters: { img: false, markdown: "true", unknown: false } },
      function (errors) {
        if (errors) return done.fail(errors);

        get({ id: test.blog.id }, function (err, blog) {
          if (err) return done.fail(err);

          expect(blog.converters.img).toBe(false);
          expect(blog.converters.markdown).toBe(true);
          expect(blog.converters.docx).toBe(true);
          expect(blog.converters.unknown).toBe(undefined);

          done();
        });
      }
    );
  });

  it("updates the handle host without touching custom domains", function (done) {
    var test = this;
    var originalHandle = test.blog.handle;
    var newHandle = originalHandle + "new";
    var oldHostKey = key.domain(originalHandle + "." + config.host);
    var newHostKey = key.domain(newHandle + "." + config.host);
    var preservedKey = key.domain("keep." + config.host);
    var customDomain = "custom-domain.test";
    var customDomainKey = key.domain(customDomain);

    client
      .set(preservedKey, "keep")
      .then(function () {
        set(test.blog.id, { domain: customDomain }, function (err) {
          if (err) return done.fail(err);

          client
            .mGet([oldHostKey, customDomainKey])
            .then(function (valuesBefore) {
              expect(valuesBefore[0]).toBe(test.blog.id);
              expect(valuesBefore[1]).toBe(test.blog.id);

              set(test.blog.id, { handle: newHandle }, function (err) {
                if (err) return done.fail(err);

                client
                  .mGet([oldHostKey, preservedKey, newHostKey, customDomainKey])
                  .then(function (values) {
                    expect(values[0]).toBe(null);
                    expect(values[1]).toBe("keep");
                    expect(values[2]).toBe(test.blog.id);
                    expect(values[3]).toBe(test.blog.id);
                    done();
                  })
                  .catch(function (err) {
                    done.fail(err);
                  });
              });
            })
            .catch(function (err) {
              done.fail(err);
            });
        });
      })
      .catch(function (err) {
        done.fail(err);
      });
  });

  it("updates the cacheID when the menu changes", function (done) {
    var test = this;

    get({ id: test.blog.id }, function (err, before) {
      if (err) return done.fail(err);

      var updatedMenu = before.menu.map(function (item, index) {
        if (index === 0) {
          return Object.assign({}, item, {
            label: item.label + " Updated",
          });
        }

        return item;
      });

      var originalCacheID = before.cacheID;

      set(test.blog.id, { menu: updatedMenu }, function (err) {
        if (err) return done.fail(err);

        get({ id: test.blog.id }, function (err, after) {
          if (err) return done.fail(err);

          expect(after.menu[0].label).toBe(updatedMenu[0].label);
          expect(after.cacheID).toBeGreaterThan(originalCacheID);
          expect(after.cssURL).toContain("cache=" + after.cacheID);
          expect(after.scriptURL).toContain("cache=" + after.cacheID);

          done();
        });
      });
    });
  });

  it("increments cacheID monotonically when Date.now() would not advance", function (done) {
    var test = this;
    var frozenNow = 1000000000000;

    get({ id: test.blog.id }, function (err, before) {
      if (err) return done.fail(err);

      var originalCacheID = Number(before.cacheID) || 0;
      var dateNow = Date.now;
      Date.now = function () {
        return frozenNow;
      };

      var menuWithChange = before.menu.map(function (item, index) {
        return index === 0
          ? Object.assign({}, item, { label: item.label + " X" })
          : item;
      });

      set(test.blog.id, { menu: menuWithChange }, function (err) {
        Date.now = dateNow;
        if (err) return done.fail(err);

        get({ id: test.blog.id }, function (err, after) {
          if (err) return done.fail(err);

          expect(after.cacheID).toBeGreaterThan(originalCacheID);
          expect(after.cacheID).toBeGreaterThanOrEqual(frozenNow);
          done();
        });
      });
    });
  });
});
