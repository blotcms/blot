var clfdate = require("helper/clfdate");
var { pipeline } = require("stream/promises");
var s3 = require("./s3");

// Sends an object in the storage bucket as the response, the way
// res.sendFile sends a file: Range, If-None-Match and If-Modified-Since are
// passed to S3, and the status (200, 206, 304, 416), validators and caching
// headers are set from its answer. Shared by storage/assets and the S3
// backend of storage/folder.
//
//   options  maxAge, immutable and headers, as for res.sendFile
//   hooks    notFound(err): the error to throw when there is no such object
//            label: what a failed stream is logged as

// Formats a Cache-Control the way send (and so res.sendFile) does: maxAge is
// milliseconds or a string like "1y", and is capped at a year.
var MAX_MAXAGE = 31536000000;
var UNITS = {
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
  w: 604800000,
  y: 31557600000,
};

function toMilliseconds(value) {
  if (typeof value === "number") return value;

  var match = /^\s*(-?\d*\.?\d+)\s*(ms|s|m|h|d|w|y)?\s*$/i.exec(String(value));

  if (!match) return 0;

  return parseFloat(match[1]) * UNITS[(match[2] || "ms").toLowerCase()];
}

function cacheControl(options) {
  var maxAge = Math.min(
    Math.max(0, toMilliseconds(options.maxAge || 0)),
    MAX_MAXAGE
  );
  var value = "public, max-age=" + Math.floor(maxAge / 1000);

  if (options.immutable) value += ", immutable";

  return value;
}

function hasHeader(headers, name) {
  return Object.keys(headers || {}).some(function (key) {
    return key.toLowerCase() === name;
  });
}

function applyHeaders(res, headers) {
  Object.keys(headers || {}).forEach(function (name) {
    res.setHeader(name, headers[name]);
  });
}

async function sendObject(req, res, objectKey, options, hooks) {
  options = options || {};

  var isHead = req.method === "HEAD";
  var object;

  try {
    object = await s3.open(objectKey, {
      head: isHead,
      // S3 can't answer several ranges in one GET; ignoring a multi-range
      // header and sending the whole object (200) is valid HTTP
      range: /,/.test(req.headers.range || "") ? undefined : req.headers.range,
      ifNoneMatch: req.headers["if-none-match"],
      ifModifiedSince: req.headers["if-modified-since"],
    });
  } catch (err) {
    if (s3.isNotFound(err)) throw hooks.notFound(err);
    throw err;
  }

  res.statusCode = object.status;
  res.setHeader("Accept-Ranges", "bytes");

  if (object.etag) res.setHeader("ETag", object.etag);
  if (object.modified)
    res.setHeader("Last-Modified", object.modified.toUTCString());

  if (!hasHeader(options.headers, "cache-control")) {
    res.setHeader("Cache-Control", cacheControl(options));
  }

  if (object.status === 304) {
    applyHeaders(res, options.headers);
    return res.end();
  }

  if (object.status === 416) {
    applyHeaders(res, options.headers);
    res.setHeader("Content-Range", "bytes */" + object.size);
    res.setHeader("Content-Length", "0");
    return res.end();
  }

  if (object.contentType) res.setHeader("Content-Type", object.contentType);

  applyHeaders(res, options.headers);

  res.setHeader("Content-Length", object.contentLength);

  if (object.contentRange) res.setHeader("Content-Range", object.contentRange);

  if (isHead) return res.end();

  try {
    await pipeline(object.body, res);
  } catch (err) {
    // The client went away, or S3 dropped the connection part way through.
    // Headers are already sent, so there's nothing left to tell the caller.
    object.body.destroy();
    res.destroy();

    if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.log(clfdate(), hooks.label, err.message);
    }
  }
}

module.exports = sendObject;
