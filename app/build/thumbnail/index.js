var Candidates = require("./candidates");
var Create = require("./create");
var Transformer = require("helper/transformer");
var STORE_PREFIX = "thumbnails";
var debug = require("debug")("blot:entry:build:thumbnail");
var { report } = require("build/flags");

async function thumbnail(blog, path, metadata, html) {
  var store, candidates;

  // Attempt to build a list of candidate image
  // src and paths based on the content of the
  // html generated from the blog post and the
  // metadata extracted from the blog post.
  candidates = Candidates(metadata, html);

  debug(blog.id, path, candidates);

  store = new Transformer(blog.id, STORE_PREFIX);

  // An image that can't be a thumbnail (too small, unsupported format) is
  // stored as a result like any other, keyed by the file's content, so the
  // next build of the post skips its sandbox job. Only an image the job read
  // and refused is stored (err.invalid); a failure to read it or to run the
  // job is not, so it is tried again.
  async function createOrReject(path) {
    try {
      return await Create(blog.id, path);
    } catch (err) {
      if (err && err.invalid) return { rejected: err.message };
      throw err;
    }
  }

  // The first candidate which produces thumbnails wins
  var thumbnails = null;
  var problem = null;

  function failed(candidate, err, rejected) {
    if (!problem) problem = { candidate, err, rejected };
  }

  for (var candidate of candidates) {
    var found = await lookup(store, candidate, createOrReject, failed);

    // We don't care if a candidate produces an error
    // we just keep going on down the list...
    if (found) {
      thumbnails = found;
      break;
    }
  }

  debug(blog.id, "final thumbnails", thumbnails);

  // The post has images but none made a thumbnail: say why, for the first
  if (!thumbnails && problem) {
    report(
      problem.err && problem.err.timedOut
        ? { code: "THUMBNAIL_TIMEOUT", target: problem.candidate }
        : {
            code: "THUMBNAIL_FAILED",
            target: problem.candidate,
            error: problem.rejected || (problem.err && problem.err.message),
          }
    );
  }

  return thumbnails;
}

// Looks up the thumbnails for one candidate. Resolves to undefined if there
// aren't any, whether the candidate was rejected or failed.
async function lookup(store, candidate, create, failed) {
  var thumbnails;

  try {
    thumbnails = await store.lookup(candidate, create);
  } catch (err) {
    debug(candidate, err);
    failed(candidate, err);
    return undefined;
  }

  if (thumbnails && thumbnails.rejected !== undefined) {
    debug(candidate, "rejected:", thumbnails.rejected);
    failed(candidate, null, thumbnails.rejected);
    return undefined;
  }

  debug(candidate, null, thumbnails);

  return thumbnails;
}

module.exports = thumbnail;
