describe("storage/s3", function () {
  var s3 = require("storage/s3");
  var config = require("config");
  var useBucket = require("./minio");

  useBucket();

  describe("assertConfigured", function () {
    it("passes when a bucket is configured", function () {
      expect(function () {
        s3.assertConfigured();
      }).not.toThrow();
    });

    it("fails with a clear error when there is no bucket", function () {
      var bucket = config.assets.bucket;

      config.assets.bucket = "";

      try {
        expect(function () {
          s3.assertConfigured();
        }).toThrowError(/BLOT_ASSETS_BUCKET is not set/);

      } finally {
        config.assets.bucket = bucket;
      }
    });

    it("is refused by every call that needs the bucket", async function () {
      var bucket = config.assets.bucket;
      var error;

      config.assets.bucket = "";

      try {
        await s3.head("blog_x/a");
      } catch (err) {
        error = err;
      } finally {
        config.assets.bucket = bucket;
      }

      expect(error && error.message).toMatch(/BLOT_ASSETS_BUCKET is not set/);
    });
  });
});
