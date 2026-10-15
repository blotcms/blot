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
      var bucket = config.storage.bucket;

      config.storage.bucket = "";

      try {
        expect(function () {
          s3.assertConfigured();
        }).toThrowError(/BLOT_STORAGE_BUCKET is not set/);

      } finally {
        config.storage.bucket = bucket;
      }
    });

    it("is refused by every call that needs the bucket", async function () {
      var bucket = config.storage.bucket;
      var error;

      config.storage.bucket = "";

      try {
        await s3.head("blog_x/a");
      } catch (err) {
        error = err;
      } finally {
        config.storage.bucket = bucket;
      }

      expect(error && error.message).toMatch(/BLOT_STORAGE_BUCKET is not set/);
    });
  });
});
