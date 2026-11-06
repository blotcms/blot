var Candidates = require("./candidates");
var Create = require("./create");
var Transformer = require("helper/transformer");
var withCallback = require("helper/withCallback");
var STORE_PREFIX = "thumbnails";
var debug = require("debug")("blot:entry:build:thumbnail");

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
  function createOrReject(path, done) {
    Create(blog.id, path).then(
      function (thumbnails) {
        done(null, thumbnails);
      },
      function (err) {
        if (err && err.invalid) return done(null, { rejected: err.message });
        done(err);
      }
    );
  }

  // The first candidate which produces thumbnails wins
  var thumbnails = null;

  for (var candidate of candidates) {
    var found = await lookup(store, candidate, createOrReject);

    // We don't care if a candidate produces an error
    // we just keep going on down the list...
    if (found) {
      thumbnails = found;
      break;
    }
  }

  debug(blog.id, "final thumbnails", thumbnails);

  return thumbnails;
}

// Looks up the thumbnails for one candidate. Resolves to undefined if there
// aren't any, whether the candidate was rejected or failed.
function lookup(store, candidate, create) {
  return new Promise(function (resolve) {
    store.lookup(candidate, create, function (err, thumbnails) {
      if (thumbnails && thumbnails.rejected !== undefined) {
        debug(candidate, "rejected:", thumbnails.rejected);
        thumbnails = undefined;
      }

      if (err) {
        debug(err);
      }

      debug(candidate, err, thumbnails);

      resolve(thumbnails);
    });
  });
}

module.exports = withCallback(thumbnail);
