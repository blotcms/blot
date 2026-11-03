// Appends shadow mode's log lines to a file as well as stdout (see log() in
// ./index.js and config.git_store.shadow_log). The containers' stdout is lost
// when a deploy replaces them, and the lines are wanted for a week or more.
//
// The units, both processes in each, and one-off scripts can all append to the
// same file at once. Each line is one appendFile call (O_APPEND), so whole
// lines land one after another. Nothing here waits or throws: a failed write
// is dropped, with one warning per process.
//
// The file is bounded: when it is over MAX_BYTES it is renamed to <file>.1,
// replacing the previous .1, and a new one is started. A process checks the
// size on its first write and then after every CHECK_BYTES it has written. If
// two rename at the same moment, the second moves the file the first just
// started, so a few lines go with the old .1 and are lost.
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 256 * 1024 * 1024;
const CHECK_BYTES = 1024 * 1024;

let sinceCheck = Infinity;
let warned = false;

function warn(err) {
  if (warned) return;
  warned = true;
  try {
    console.warn("[git-store-shadow] cannot write the log file:", err && err.message);
  } catch (e) {}
}

function rotateIfNeeded(file, maxBytes, done) {
  fs.stat(file, function (err, stat) {
    if (err || stat.size <= maxBytes) return done();
    fs.rename(file, file + ".1", function () {
      done();
    });
  });
}

// file: the path ("" is off); line: one line, without its newline
module.exports = function append(file, line, options) {
  try {
    if (!file) return;

    const maxBytes = (options && options.maxBytes) || MAX_BYTES;
    const data = line + "\n";

    const write = function () {
      fs.appendFile(file, data, function (err) {
        if (err) warn(err);
      });
    };

    fs.mkdir(path.dirname(file), { recursive: true }, function (err) {
      if (err) return warn(err);
      sinceCheck += Buffer.byteLength(data);
      if (sinceCheck < CHECK_BYTES) return write();
      sinceCheck = 0;
      rotateIfNeeded(file, maxBytes, write);
    });
  } catch (err) {
    warn(err);
  }
};

module.exports._reset = function () {
  sinceCheck = Infinity;
  warned = false;
};
