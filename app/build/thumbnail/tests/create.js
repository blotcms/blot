describe("create", function () {
  global.test.blog();
  global.test.tmp();

  var create = require("build/thumbnail/create");
  var assets = require("storage/assets");

  // metadata should be at top of queue
  // then the images in the html if there are any
  // in the order they appear in the post
  it("creates thumbnails", function (done) {
    var test = this;
    var path = __dirname + "/images/portrait.jpg";
    var ratio;

    // {density: 2400} is only for svg images, but it doesn't
    // currently cause any trouble if we pass this for all formats
    // the number itself could be tuned based on the size of the source
    // image but I'd need to do more research about the meaning:
    // https://github.com/lovell/sharp/issues/1421#issuecomment-514446234
    require("sharp")(path, { density: 2400 }).metadata(
      function (err, metadata) {
        if (err) return done.fail(err);
        ratio = Math.floor(metadata.width / metadata.height);

        (async function () {
          let thumbnails;
          try {
            thumbnails = await create(test.blog.id, path);
          } catch (err) {
            return done.fail(err);
          }

          expect(thumbnails).toEqual(jasmine.any(Object));

          // Square thumbnail is square
          expect(thumbnails.square.width).toEqual(thumbnails.square.height);

          // Other thumbnails preserve original aspect ratio
          expect(
            Math.floor(thumbnails.large.width / thumbnails.large.height)
          ).toEqual(ratio);
          expect(
            Math.floor(thumbnails.medium.width / thumbnails.medium.height)
          ).toEqual(ratio);
          expect(
            Math.floor(thumbnails.small.width / thumbnails.small.height)
          ).toEqual(ratio);
          expect(thumbnails.square.name).toEqual("square.jpg");

          // Each thumbnail was uploaded
          try {
            const found = await Promise.all(
              Object.keys(thumbnails).map(function (size) {
                return assets.exists(test.blog.id, thumbnails[size].path);
              })
            );
            found.forEach(function (exists) {
              expect(exists).toBe(true);
            });

            done();
          } catch (err) {
            done.fail(err);
          }
        })();
      }
    );
  });

  describe("directories", function () {
    var images = __dirname + "/images/";

    it("names the directory for the image, so the same image gets the same one", async function () {
      var first = await create(this.blog.id, images + "portrait.jpg");
      var second = await create(this.blog.id, images + "portrait.jpg");

      expect(first.small.path).toMatch(
        /^\/_thumbnails\/[a-f0-9]{32}\/small\.jpg$/
      );
      expect(second.small.path).toBe(first.small.path);
    });

    it("gives another image another directory", async function () {
      var a = await create(this.blog.id, images + "portrait.jpg");
      var b = await create(this.blog.id, images + "p3.jpg");

      expect(b.small.path).not.toBe(a.small.path);
    });

    it("makes an image's thumbnails once for two builds at a time", async function () {
      var sandbox = require("sandbox");
      var run = spyOn(sandbox, "run").and.callThrough();

      var [a, b] = await Promise.all([
        create(this.blog.id, images + "portrait.jpg"),
        create(this.blog.id, images + "portrait.jpg"),
      ]);

      expect(run).toHaveBeenCalledTimes(1);
      expect(b).toEqual(a);
      expect(await assets.exists(this.blog.id, a.small.path)).toBe(true);
    });
  });
});
