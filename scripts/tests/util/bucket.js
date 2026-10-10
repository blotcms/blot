// Creates the storage bucket (config.storage.bucket) in the simulated S3 the
// tests run against, so everything which builds or uploads assets has
// somewhere to put them. Called by the runner (scripts/tests/index.js) before
// the first spec. The bucket, endpoint and credentials come from the same
// environment variables the app reads (BLOT_STORAGE_BUCKET, BLOT_STORAGE_ENDPOINT,
// BLOT_AWS_KEY, BLOT_AWS_SECRET), which scripts/tests/invoke.sh and
// .github/workflows/node.yml set for a MinIO started alongside the tests.
const s3 = require("storage/s3");
const { CreateBucketCommand } = require("@aws-sdk/client-s3");
const config = require("config");

module.exports = async function ensureBucket() {
  try {
    s3.assertConfigured();
  } catch (err) {
    throw new Error(
      err.message +
        "\nThe tests need a simulated S3: run them with `npm test`, which " +
        "starts MinIO and sets BLOT_STORAGE_BUCKET, BLOT_STORAGE_ENDPOINT, " +
        "BLOT_AWS_KEY and BLOT_AWS_SECRET."
    );
  }

  // MinIO may still be starting when the runner is
  for (let attempt = 1; ; attempt++) {
    try {
      await s3.client().send(new CreateBucketCommand({ Bucket: config.storage.bucket }));
      return;
    } catch (err) {
      if (err.name === "BucketAlreadyOwnedByYou") return;
      if (attempt >= 30 || err.$metadata) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};
