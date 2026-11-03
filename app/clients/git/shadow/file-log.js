// Appends shadow mode's log lines to a file as well as stdout (see log() in
// ./index.js and config.git_store.shadow_log). The containers' stdout is lost
// when a deploy replaces them, and the lines are wanted for a week or more.
//
// The units, both processes in each, and one-off scripts can all append to the
// same file at once. Each line is one append (O_APPEND), so whole lines land
// one after another. The append is synchronous: a line is short and the file
// is on local disk, and a script which calls process.exit() straight after
// its last line still has that line in the file. Nothing here throws: a failed
// write is dropped, with one warning per process.
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

function rotateIfNeeded(file, maxBytes) {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + ".1");
  } catch (err) {
    // Not there yet, or another process moved it first
  }
}

// file: the path ("" is off); line: one line, without its newline
module.exports = function append(file, line, options) {
  try {
    if (!file) return;

    const maxBytes = (options && options.maxBytes) || MAX_BYTES;
    const data = line + "\n";

    sinceCheck += Buffer.byteLength(data);
    if (sinceCheck >= CHECK_BYTES) {
      sinceCheck = 0;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded(file, maxBytes);
    }

    try {
      fs.appendFileSync(file, data);
    } catch (err) {
      // Its directory was removed since the last check: make it once more
      if (err.code !== "ENOENT") throw err;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, data);
    }
  } catch (err) {
    warn(err);
  }
};

module.exports._reset = function () {
  sinceCheck = Infinity;
  warned = false;
};
