// The object store interface (see memory.js) over an S3 bucket.
//
// The host passes in a configured S3Client, the bucket, and the prefix every
// key sits under ({blogID}/git/). Only the S3 API subset Backblaze B2 also
// supports is used: plain and multipart PUT, ranged GET, HEAD, DELETE and
// LIST, one conditional write: a PUT with If-None-Match: * (putIfAbsent),
// which is what makes a manifest swap safe, and one conditional read: a GET
// with If-None-Match: <etag> (get with ifNoneMatch), answered 304 Not
// Modified while the object is unchanged. No tagging or storage classes.
const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");
const { Readable } = require("stream");
const { NotFoundError, TooLargeError } = require("../errors");
const { createSemaphore } = require("../limit");

// S3 wants every part but the last to be at least 5 MiB. A part is held in
// memory while it uploads, so memory for a large upload is about
// partSize * concurrency whatever the object's size.
const PART_SIZE = 8 * 1024 * 1024;
const PART_CONCURRENCY = 4;

// A ranged body which fails midway can't be resumed by the SDK, so a read
// starts again a couple of times before giving up
const READ_ATTEMPTS = 3;

const MISSING = new Set(["NoSuchKey", "NotFound", "NoSuchBucket"]);

function isMissing(err) {
  return (
    MISSING.has(err.name) ||
    (err.$metadata && err.$metadata.httpStatusCode === 404)
  );
}

function isPastEnd(err) {
  return (
    err.name === "InvalidRange" ||
    (err.$metadata && err.$metadata.httpStatusCode === 416)
  );
}

function isNotModified(err) {
  return (
    err.name === "NotModified" ||
    (err.$metadata && err.$metadata.httpStatusCode === 304)
  );
}

function isPreconditionFailed(err) {
  return (
    err.name === "PreconditionFailed" ||
    (err.$metadata && err.$metadata.httpStatusCode === 412)
  );
}

// S3 answers 409 ConditionalRequestConflict when writers to a key are racing
// and it can't yet say which wins; the request is simply sent again
function isConflict(err) {
  return (
    err.name === "ConditionalRequestConflict" ||
    (err.$metadata && err.$metadata.httpStatusCode === 409)
  );
}

const CONFLICT_ATTEMPTS = 4;
const CONFLICT_DELAY = 50;

function createS3Store({
  client,
  bucket,
  prefix = "",
  partSize = PART_SIZE,
  partConcurrency = PART_CONCURRENCY,
  conflictDelay = CONFLICT_DELAY,
}) {
  if (!client || !bucket)
    throw new Error("createS3Store needs a client and a bucket");
  if (partSize < 5 * 1024 * 1024)
    throw new Error("S3 parts must be at least 5 MiB");

  const id = "s3:" + bucket + "/" + prefix;
  const full = (key) => prefix + key;

  async function head(key) {
    try {
      const out = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: full(key) })
      );
      return {
        size: out.ContentLength,
        lastModified: out.LastModified ? out.LastModified.getTime() : null,
      };
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  function rangeHeader(offset, length) {
    if (offset === 0 && length === Infinity) return undefined;
    const end = length === Infinity ? "" : offset + length - 1;
    return "bytes=" + offset + "-" + end;
  }

  async function open(key, offset, length, ifNoneMatch) {
    try {
      return await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: full(key),
          Range: rangeHeader(offset, length),
          IfNoneMatch: ifNoneMatch || undefined,
        })
      );
    } catch (err) {
      if (isMissing(err)) throw new NotFoundError("No such key: " + key);
      throw err;
    }
  }

  async function read(key, offset, length) {
    if (length <= 0) return Buffer.alloc(0);
    let lastError;

    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      try {
        const out = await open(key, offset, length);
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (err) {
        if (isPastEnd(err)) return Buffer.alloc(0);
        if (err instanceof NotFoundError) throw err;
        lastError = err;
      }
    }

    throw lastError;
  }

  // With ifNoneMatch (see memory.js) it is a conditional GET, which S3 (and
  // B2) answer with 304, thrown by the SDK, while the ETag is the one given
  async function get(key, { maxBytes = Infinity, ifNoneMatch } = {}) {
    const conditional = ifNoneMatch !== undefined;
    let out;
    try {
      out = await open(key, 0, Infinity, ifNoneMatch);
    } catch (err) {
      if (conditional && ifNoneMatch && isNotModified(err))
        return { notModified: true, etag: ifNoneMatch };
      throw err;
    }
    if (out.ContentLength > maxBytes) {
      out.Body.destroy();
      throw new TooLargeError(key + " is larger than " + maxBytes);
    }
    const bytes = Buffer.from(await out.Body.transformToByteArray());
    return conditional ? { bytes, etag: out.ETag || null } : bytes;
  }

  // Opens the object when first read, so a missing key surfaces as the
  // stream's error
  function stream(key, offset = 0, length = Infinity) {
    async function* chunks() {
      const out = await open(key, offset, length);
      yield* out.Body;
    }
    return Readable.from(chunks(), { objectMode: false });
  }

  async function putWhole(key, buffer) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: full(key),
        Body: buffer,
        ContentType: "application/octet-stream",
      })
    );
  }

  // Cuts a stream into parts of exactly partSize bytes (the last may be
  // smaller), yielding each as one Buffer
  async function* parts(body) {
    let pending = [];
    let size = 0;

    for await (const chunk of body) {
      let rest = Buffer.from(chunk);
      while (size + rest.length >= partSize) {
        const take = partSize - size;
        yield Buffer.concat([...pending, rest.subarray(0, take)]);
        rest = rest.subarray(take);
        pending = [];
        size = 0;
      }
      if (rest.length) {
        pending.push(rest);
        size += rest.length;
      }
    }

    if (size) yield Buffer.concat(pending);
  }

  // Uploads parts as they are cut from the stream. A part is only read once
  // an upload slot is free, which is what bounds memory.
  async function putMultipart(key, ahead, iterator) {
    const created = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: full(key),
        ContentType: "application/octet-stream",
      })
    );
    const uploadId = created.UploadId;
    const acquire = createSemaphore(partConcurrency);
    const uploads = [];
    let failure;
    let number = 0;

    async function uploadPart(partNumber, body, release) {
      try {
        const out = await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: full(key),
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: body,
          })
        );
        return { ETag: out.ETag, PartNumber: partNumber };
      } catch (err) {
        failure = failure || err;
      } finally {
        release();
      }
    }

    try {
      for (const body of ahead)
        uploads.push(uploadPart(++number, body, await acquire()));

      while (!failure) {
        const release = await acquire();
        const next = failure ? { done: true } : await iterator.next();
        if (next.done) {
          release();
          break;
        }
        uploads.push(uploadPart(++number, next.value, release));
      }

      const done = await Promise.all(uploads);
      if (failure) throw failure;

      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: full(key),
          UploadId: uploadId,
          MultipartUpload: { Parts: done },
        })
      );
    } catch (err) {
      await Promise.all(uploads);
      await client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: full(key),
            UploadId: uploadId,
          })
        )
        .catch(() => {});
      throw err;
    }
  }

  async function put(key, body) {
    if (Buffer.isBuffer(body) && body.length <= partSize)
      return putWhole(key, body);

    // Iterating a Buffer would give its bytes, not a chunk
    const iterator = parts(Buffer.isBuffer(body) ? [body] : body)[
      Symbol.asyncIterator
    ]();

    // The iterator is closed however this ends, so a source which is a
    // generator runs its finally and a file stream closes its descriptor
    try {
      const first = await iterator.next();
      if (first.done) return await putWhole(key, Buffer.alloc(0));

      const second = await iterator.next();
      if (second.done) return await putWhole(key, first.value);

      return await putMultipart(key, [first.value, second.value], iterator);
    } finally {
      await iterator.return().catch(() => {});
    }
  }

  // Creates the key unless it exists. The condition is checked by S3 itself,
  // atomically with the write, so of several writers exactly one is told true.
  async function putIfAbsent(key, buffer) {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: full(key),
            Body: buffer,
            ContentType: "application/octet-stream",
            IfNoneMatch: "*",
          })
        );
        return true;
      } catch (err) {
        if (isPreconditionFailed(err)) return false;
        if (!isConflict(err) || attempt === CONFLICT_ATTEMPTS) throw err;
        await new Promise((resolve) =>
          setTimeout(resolve, conflictDelay * attempt)
        );
      }
    }
  }

  async function remove(key) {
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: full(key) })
    );
  }

  async function* list(listPrefix = "") {
    let token;
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: full(listPrefix),
          ContinuationToken: token,
        })
      );
      for (const item of out.Contents || []) {
        yield {
          key: item.Key.slice(prefix.length),
          size: item.Size,
          lastModified: item.LastModified ? item.LastModified.getTime() : null,
        };
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  return {
    id,
    head,
    read,
    get,
    stream,
    put,
    putIfAbsent,
    delete: remove,
    list,
  };
}

module.exports = createS3Store;
