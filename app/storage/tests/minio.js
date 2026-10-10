// Shared setup for the specs which need a bucket of their own. Not a spec
// itself. The test runner provides MinIO and the app's own configuration for
// it (BLOT_STORAGE_ENDPOINT, BLOT_AWS_KEY, ...): scripts/tests/invoke.sh
// locally, .github/workflows/node.yml in CI. Every spec has a bucket anyway
// (scripts/tests/util/bucket.js); these want an empty one, which they can fill,
// break, and delete without disturbing anything else.
const crypto = require("crypto");
const config = require("config");
const s3 = require("storage/s3");
const { CreateBucketCommand, DeleteBucketCommand } = require("@aws-sdk/client-s3");

// Call inside a describe(). Gives the specs in it a bucket of their own,
// configured as config.storage for their duration, and undoes that after.
// Returns { bucket }.
module.exports = function useBucket() {
  const state = {
    bucket: "blot-test-" + crypto.randomBytes(6).toString("hex"),
  };
  let saved;
  let endpoint;

  beforeAll(async function () {
    saved = {
      storage: Object.assign({}, config.storage),
      aws: Object.assign({}, config.aws),
    };
    endpoint = config.storage.endpoint;

    config.storage.bucket = state.bucket;
    s3.reset();

    await s3.client().send(new CreateBucketCommand({ Bucket: state.bucket }));
  });

  afterAll(async function () {
    if (!saved) return;

    // Put the real endpoint back in case a spec pointed it elsewhere
    config.storage.endpoint = endpoint;
    config.storage.bucket = state.bucket;
    s3.reset();

    await s3.removePrefix("");
    await s3.client().send(new DeleteBucketCommand({ Bucket: state.bucket }));

    Object.assign(config.storage, saved.storage);
    Object.assign(config.aws, saved.aws);
    s3.reset();
  });

  // Each spec starts with an empty bucket
  beforeEach(async function () {
    config.storage.endpoint = endpoint;
    config.storage.bucket = state.bucket;
    s3.reset();

    await s3.removePrefix("");
  });

  return state;
};
