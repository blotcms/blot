// Connects the harness to the spike's MinIO: an S3 client for the direct or
// the proxied endpoint, and the store (counted) for one repository.
const { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const http = require("http");
const { createS3Store } = require("../../../../app/clients/git/store");
const { createCounters, instrumentClient, countStore } = require("./counting");
const { StaleManifestError } = require("../../../../app/clients/git/store").errors;

const BUCKET = "git-store-spike";
const ENDPOINTS = {
  direct: process.env.GIT_STORE_SPIKE_DIRECT || "http://127.0.0.1:19000",
  proxied: process.env.GIT_STORE_SPIKE_PROXIED || "http://127.0.0.1:19100",
};

function createClient(endpoint, options = {}) {
  // failure injection decides per connection, so those runs open one per request
  const agent = new http.Agent({ keepAlive: options.keepAlive !== false, maxSockets: 64 });
  return new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "spike", secretAccessKey: "spike-secret" },
    maxAttempts: options.maxAttempts || 3,
    requestHandler: {
      httpAgent: agent,
      connectionTimeout: options.connectionTimeout || 5000,
      requestTimeout: options.requestTimeout || 0,
      // without this the SDK only logs a request which exceeds its timeout
      throwOnRequestTimeout: true,
    },
  });
}

async function ensureBucket() {
  const client = createClient(ENDPOINTS.direct);
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
  client.destroy();
}

// A repository's store. `via` is "direct" or "proxied". Everything it does is
// counted; read the counts with counters.take().
function connect({ blogID, via = "proxied", options = {} }) {
  const counters = createCounters();
  const client = instrumentClient(createClient(ENDPOINTS[via], options), counters);
  const prefix = "git/" + blogID + "/";
  const raw = createS3Store({ client, bucket: BUCKET, prefix, ...(options.store || {}) });
  const store = countStore(raw, counters);

  // The conditional write the immutable manifests need. The foundation's
  // store has no such call (yet), so the harness makes it here.
  store.putIfAbsent = async function putIfAbsent(key, buffer) {
    counters.op("putIfAbsent", 0);
    counters.bytes("putIfAbsent", buffer.length);
    try {
      await client.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: prefix + key, Body: buffer, IfNoneMatch: "*" })
      );
    } catch (err) {
      if (err.$metadata && (err.$metadata.httpStatusCode === 412 || err.$metadata.httpStatusCode === 409)) {
        throw new StaleManifestError("manifest object " + key + " already exists");
      }
      throw err;
    }
  };

  return { store, client, counters, prefix, bucket: BUCKET, close: () => client.destroy() };
}

module.exports = { connect, ensureBucket, BUCKET, ENDPOINTS, createClient };
