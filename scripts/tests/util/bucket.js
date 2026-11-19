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

// Generous: on a loaded CI runner MinIO can take tens of seconds to listen
const READY_TIMEOUT_MS = 120000;

module.exports = async function ensureBucket() {
  try {
    s3.assertConfigured();
  } catch (err) {
    throw new Error(
      err.message +
        "\nThe tests need a simulated S3: run them with `npm test`, which " +
        "starts MinIO and sets BLOT_STORAGE_BUCKET, BLOT_STORAGE_ENDPOINT, " +
        "BLOT_AWS_KEY and BLOT_AWS_SECRET.",
      { cause: err }
    );
  }

  // MinIO may still be starting, and slow to answer while every lane on the
  // runner is booting. The SDK retries a failed connection itself and then
  // throws an error that carries $metadata (the attempt count), so only an
  // HTTP status shows that MinIO answered. A 5xx is MinIO still starting
  // (503 "server not initialized"); anything else without a status is "not
  // ready yet" too.
  const deadline = Date.now() + READY_TIMEOUT_MS;

  for (;;) {
    try {
      await s3
        .client()
        .send(new CreateBucketCommand({ Bucket: config.storage.bucket }));
      return;
    } catch (err) {
      if (err.name === "BucketAlreadyOwnedByYou") return;
      const status = err.$metadata && err.$metadata.httpStatusCode;
      if (status && status < 500) throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          "The simulated S3 at " +
            config.storage.endpoint +
            " did not accept a connection within " +
            READY_TIMEOUT_MS / 1000 +
            "s: " +
            err.message,
          { cause: err }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};
