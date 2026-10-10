// Shared setup for the specs which run against a real (simulated) S3. Not a
// spec itself. The test runner provides MinIO and passes its address in
// BLOT_TEST_S3_ENDPOINT (+ _KEY and _SECRET): scripts/tests/invoke.sh
// locally, .github/workflows/node.yml in CI. Without it, the specs are
// skipped locally, but fail where BLOT_TEST_S3_REQUIRED is set (CI), so they
// can't silently stop running.
const crypto = require("crypto");
const config = require("config");
const s3 = require("storage/s3");
const { CreateBucketCommand, DeleteBucketCommand } = require("@aws-sdk/client-s3");

const MISSING =
  "BLOT_TEST_S3_ENDPOINT is not set, so the S3 specs can't run. " +
  "Run the tests with `npm test` (which starts MinIO) or point it at one.";

// Call inside a describe(). Gives the specs in it a bucket of their own,
// configured as config.storage for their duration, and undoes that after.
// Returns { bucket }.
module.exports = function useBucket() {
  const state = {
    bucket: "blot-test-" + crypto.randomBytes(6).toString("hex"),
    available: !!process.env.BLOT_TEST_S3_ENDPOINT,
  };
  let saved;

  beforeAll(async function () {
    if (!state.available) {
      if (process.env.BLOT_TEST_S3_REQUIRED) throw new Error(MISSING);
      return;
    }

    saved = {
      storage: Object.assign({}, config.storage),
      assets: Object.assign({}, config.assets),
      aws: Object.assign({}, config.aws),
    };

    config.storage.bucket = state.bucket;
    config.storage.endpoint = process.env.BLOT_TEST_S3_ENDPOINT;
    config.storage.region = "us-east-1";
    config.assets.read = "disk";
    config.aws.key = process.env.BLOT_TEST_S3_KEY;
    config.aws.secret = process.env.BLOT_TEST_S3_SECRET;
    s3.reset();

    await s3.client().send(new CreateBucketCommand({ Bucket: state.bucket }));
  });

  afterAll(async function () {
    if (!saved) return;

    // Put the real endpoint back in case a spec pointed it elsewhere
    config.storage.endpoint = process.env.BLOT_TEST_S3_ENDPOINT;
    s3.reset();

    await s3.removePrefix("");
    await s3.client().send(new DeleteBucketCommand({ Bucket: state.bucket }));

    Object.assign(config.storage, saved.storage);
    Object.assign(config.assets, saved.assets);
    Object.assign(config.aws, saved.aws);
    s3.reset();
  });

  // Each spec starts with an empty bucket
  beforeEach(async function () {
    if (!state.available) pending(MISSING);

    config.storage.endpoint = process.env.BLOT_TEST_S3_ENDPOINT;
    config.assets.read = "disk";
    s3.reset();

    await s3.removePrefix("");
  });

  return state;
};
