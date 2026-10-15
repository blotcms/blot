const config = require("config");
const fs = require("fs-extra");
const contentTypeFor = require("./contentType");
const { isScopeName } = require("./util");

// The SDK is loaded on first use, so an app with no bucket configured never
// loads it (and starts from an image built before it was a dependency)
let sdk;

function SDK() {
  if (!sdk) sdk = require("@aws-sdk/client-s3");
  return sdk;
}

// A thin layer over the S3 API for the storage bucket (config.storage): a lazily
// created client and put/get/head/list/delete helpers which speak in
// bucket keys. storage/assets.js is the facade over them. Only the S3 API
// subset Backblaze B2 also supports is used (no tagging, storage classes or
// conditional writes), so B2 could be swapped in as the store later.
//
// Keys are "{blogID}/{path}" at the bucket root, identical to the asset's
// public CDN path.

// Assets never change once written, so a CDN may keep them for a year
const CACHE_CONTROL = "public, max-age=31536000, immutable";

// Attempts at an upload before giving up. The SDK retries too, but it can't
// resend a stream it has already consumed, so each attempt opens the file
// afresh.
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 200;

let current = null;

const NOT_CONFIGURED =
  "storage/s3: BLOT_STORAGE_BUCKET is not set. Generated assets are stored " +
  "only in the storage bucket (see config/storage-bucket/README.md); in " +
  "development and tests it is the MinIO bucket the stack creates.";

// Throws unless a storage bucket is configured. Called when the app starts so
// a missing bucket is a failed boot, not a failed upload later.
function assertConfigured() {
  if (!(config.storage && config.storage.bucket)) {
    throw new Error(NOT_CONFIGURED);
  }
}

function bucket() {
  assertConfigured();

  return config.storage.bucket;
}

// The key for an asset. relPath is relative to the blog's asset directory.
function key(blogID, relPath) {
  return blogID + "/" + relPath.replace(/^\/+/, "");
}

// The client is created on first use, from config.storage as it is then, and
// replaced if that configuration changes.
function client() {
  const { region, endpoint } = config.storage;
  const signature = [region, endpoint, config.aws.key, config.aws.secret].join(
    "|"
  );

  if (current && current.signature === signature) return current.client;

  if (current) current.client.destroy();

  const options = {
    region,
    // The default of calculating a CRC32 for every request isn't supported by
    // every S3-compatible store (B2, older MinIO). Only do it where required.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      connectionTimeout: 5000,
      // idle time on the socket, not the length of a request
      requestTimeout: 120000,
    },
  };

  if (endpoint) {
    options.endpoint = endpoint;
    options.forcePathStyle = true;
  }

  if (config.aws.key && config.aws.secret) {
    options.credentials = {
      accessKeyId: config.aws.key,
      secretAccessKey: config.aws.secret,
    };
  }

  current = { signature, client: new (SDK().S3Client)(options) };

  return current.client;
}

// Forgets the client so the next call builds one from the current config.
function reset() {
  if (current) current.client.destroy();
  current = null;
}

// True for the S3 errors which mean "no such object"
function isNotFound(err) {
  return !!(
    err &&
    (err.name === "NoSuchKey" ||
      err.name === "NotFound" ||
      (err.$metadata &&
        err.$metadata.httpStatusCode === 404 &&
        err.name !== "NoSuchBucket"))
  );
}

// Not worth retrying: the request itself is wrong, or we aren't allowed
function isPermanent(err) {
  const status = err && err.$metadata && err.$metadata.httpStatusCode;

  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Uploads a local file to the key for (blogID, relPath), with the
// Content-Type its name implies and a year of caching. This is the one place
// objects are written, shared by assets.commit and the backfill script, so
// the headers can't drift.
async function upload(blogID, relPath, localFile) {
  const objectKey = key(blogID, relPath);
  let lastError;

  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const stat = await fs.stat(localFile);

      // Stream the file; it's never read into memory whole
      const body = fs.createReadStream(localFile);

      try {
        await client().send(
          new (SDK().PutObjectCommand)({
            Bucket: bucket(),
            Key: objectKey,
            Body: body,
            ContentLength: stat.size,
            ContentType: contentTypeFor(objectKey),
            CacheControl: CACHE_CONTROL,
          })
        );
      } finally {
        body.destroy();
      }

      return { key: objectKey, size: stat.size };
    } catch (err) {
      lastError = err;

      if (err.code === "ENOENT" || isPermanent(err)) break;

      if (attempt < UPLOAD_ATTEMPTS) {
        await sleep(UPLOAD_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
      }
    }
  }

  lastError.key = objectKey;
  throw lastError;
}

// Metadata for an object ({ size, etag, modified, contentType,
// cacheControl }), or null if there's no such object.
async function head(objectKey) {
  try {
    const data = await client().send(
      new (SDK().HeadObjectCommand)({ Bucket: bucket(), Key: objectKey })
    );

    return {
      size: data.ContentLength,
      etag: data.ETag,
      modified: data.LastModified,
      contentType: data.ContentType,
      cacheControl: data.CacheControl,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// Starts a download. Resolves to the GetObject output (Body is a stream the
// caller must consume or destroy) or throws; check isNotFound(err). options
// are range, ifNoneMatch and ifModifiedSince, passed straight through.
async function get(objectKey, options) {
  options = options || {};

  const input = { Bucket: bucket(), Key: objectKey };

  if (options.range) input.Range = options.range;
  if (options.ifNoneMatch) input.IfNoneMatch = options.ifNoneMatch;
  if (options.ifModifiedSince) input.IfModifiedSince = options.ifModifiedSince;

  return client().send(new (SDK().GetObjectCommand)(input));
}

function parseDate(value) {
  if (!value) return undefined;

  const date = new Date(value);

  return isNaN(date.getTime()) ? undefined : date;
}

// Opens an object to serve over HTTP: GET (or HEAD, with options.head) with
// the request's Range, If-None-Match and If-Modified-Since passed through.
// Resolves to { status, size, contentLength, contentRange, etag, modified,
// contentType, body } where status is 200, 206, 304 (no body) or 416 (no
// body; size is the object's size). body is a stream which the caller must
// consume or destroy. Throws if there is no such object; check
// isNotFound(err).
async function open(objectKey, options) {
  options = options || {};

  const input = { Bucket: bucket(), Key: objectKey };

  if (options.range) input.Range = options.range;
  if (options.ifNoneMatch) input.IfNoneMatch = options.ifNoneMatch;

  const since = parseDate(options.ifModifiedSince);
  if (since) input.IfModifiedSince = since;

  let data;

  try {
    data = await client().send(
      options.head ? new (SDK().HeadObjectCommand)(input) : new (SDK().GetObjectCommand)(input)
    );
  } catch (err) {
    const status = err && err.$metadata && err.$metadata.httpStatusCode;

    if (status === 304) {
      // The error carries the response when the SDK keeps it; otherwise ask
      const headers = (err.$response && err.$response.headers) || {};
      const info = headers.etag ? null : await head(objectKey);

      return {
        status: 304,
        etag: headers.etag || (info && info.etag),
        modified:
          parseDate(headers["last-modified"]) || (info && info.modified),
      };
    }

    if (status === 416) {
      const info = await head(objectKey);

      if (!info) throw err;

      return { status: 416, size: info.size };
    }

    throw err;
  }

  let size = data.ContentLength;

  if (data.ContentRange) {
    const total = /\/(\d+)$/.exec(data.ContentRange);
    if (total) size = parseInt(total[1], 10);
  }

  return {
    status: data.ContentRange ? 206 : 200,
    size,
    contentLength: data.ContentLength,
    contentRange: data.ContentRange,
    etag: data.ETag,
    modified: data.LastModified,
    contentType: data.ContentType,
    body: data.Body,
  };
}

// Every object under a prefix, as { key, size, modified }, a page at a time. With a
// delimiter ("/") this also yields { prefix } for each "directory" directly
// under the prefix.
async function* listEntries(prefix, delimiter) {
  let token;

  do {
    const data = await client().send(
      new (SDK().ListObjectsV2Command)({
        Bucket: bucket(),
        Prefix: prefix,
        Delimiter: delimiter,
        ContinuationToken: token,
      })
    );

    for (const object of data.Contents || []) {
      yield { key: object.Key, size: object.Size, modified: object.LastModified };
    }

    for (const common of data.CommonPrefixes || []) {
      yield { prefix: common.Prefix };
    }

    token = data.IsTruncated ? data.NextContinuationToken : undefined;
  } while (token);
}

// The "directories" of a blog's assets scope in the bucket: {blogID}/_*/.
// Top-level objects and every other prefix under {blogID}/ (folder/, ...)
// are not assets and are not listed.
async function* listScopePrefixes(blogID) {
  const prefix = blogID + "/";

  for await (const entry of listEntries(prefix, "/")) {
    if (entry.prefix && isScopeName(entry.prefix.slice(prefix.length))) {
      yield entry.prefix;
    }
  }
}

// Every object in a blog's assets scope, as { key, size, modified }
async function* listScope(blogID) {
  for await (const prefix of listScopePrefixes(blogID)) {
    yield* listEntries(prefix);
  }
}

// Deletes every object in a blog's assets scope and nothing else under
// {blogID}/
async function removeScope(blogID) {
  const prefixes = [];

  // collected first so the listing isn't changing underneath the deletes
  for await (const prefix of listScopePrefixes(blogID)) prefixes.push(prefix);

  for (const prefix of prefixes) await removePrefix(prefix);
}

// Deletes up to 1000 keys at once
async function deleteKeys(keys) {
  if (!keys.length) return;

  const data = await client().send(
    new (SDK().DeleteObjectsCommand)({
      Bucket: bucket(),
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    })
  );

  if (data.Errors && data.Errors.length) {
    const first = data.Errors[0];
    const err = new Error(
      "storage/s3: could not delete " +
        data.Errors.length +
        " objects, e.g. " +
        first.Key +
        ": " +
        first.Code +
        " " +
        first.Message
    );
    err.name = first.Code;
    throw err;
  }
}

// Deletes everything with the prefix (which should end in "/"), a batch of
// 1000 at a time.
async function removePrefix(prefix) {
  let batch = [];

  for await (const entry of listEntries(prefix)) {
    batch.push(entry.key);

    if (batch.length >= 1000) {
      await deleteKeys(batch);
      batch = [];
    }
  }

  await deleteKeys(batch);
}

// Deletes the key itself and everything below key + "/"
async function remove(objectKey) {
  await deleteKeys([objectKey]);
  await removePrefix(objectKey + "/");
}

module.exports = {
  CACHE_CONTROL,
  assertConfigured,
  key,
  client,
  reset,
  isNotFound,
  upload,
  head,
  get,
  open,
  listEntries,
  listScopePrefixes,
  listScope,
  remove,
  removePrefix,
  removeScope,
};
