// Reads a jail's memory peak from its cgroup (memory.peak), for the broker's
// one log line per job. Root only, built-ins only, like the broker.
//
// Two kinds of cgroup:
// - one the broker made (./cgroup.js, the browser's): reused by one jail after
//   another, so memory.peak is the peak since the cgroup was made unless it is
//   reset. Kernels from 6.12 let a file descriptor reset its own peak by
//   writing to it; older ones make the file read-only. The tracker tries the
//   reset and, when it can't, says so (reset: false) and the value is the peak
//   since the cgroup was made.
// - one nsjail made for the jail (NSJAIL.<pid> under the unit's subtree), which
//   nsjail removes when it exits, after the broker has seen the jail's output
//   end but before it sees nsjail itself exit. So the broker keeps a file
//   open once the cgroup exists and reads it as often as it can: the value is
//   the highest it saw, which can miss a last spike (sampled: true).

const fs = require("fs");

const SAMPLE_MS = 100;

function read(fd) {
  const buffer = Buffer.alloc(32);
  const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
  const value = Number(buffer.subarray(0, length).toString().trim());
  return Number.isFinite(value) ? value : null;
}

// directory: the cgroup. reset: try to reset its peak first, for a cgroup that
// jails share. shared: the cgroup outlives the jail or request being measured.
// interval: read it this often (ms) until finish(), 0 to read only at finish().
// Returns { sample(), finish() -> { peak, reset, sampled, shared } }; peak is
// null when it was never readable.
function track(
  directory,
  { reset: wantReset = false, shared = false, interval = 0 } = {}
) {
  const file = directory + "/memory.peak";
  let fd = null;
  let reset = false;
  let peak = null;
  let timer = null;
  let done = false;

  function open() {
    if (fd !== null || done) return;
    if (wantReset) {
      try {
        const writable = fs.openSync(file, "r+");
        try {
          fs.writeSync(writable, "0");
          fd = writable;
          reset = true;
          return;
        } catch (e) {
          fs.closeSync(writable);
        }
      } catch (e) {}
    }
    try {
      fd = fs.openSync(file, "r");
    } catch (e) {}
  }

  function sample() {
    open();
    if (fd === null) return;
    try {
      const value = read(fd);
      if (value !== null && (peak === null || value > peak)) peak = value;
    } catch (e) {}
  }

  // Opening resets the peak, so a shared cgroup is opened now, before its jail
  // is in it
  open();
  if (interval > 0) {
    timer = setInterval(sample, interval);
    timer.unref();
  }

  return {
    sample,
    finish() {
      sample();
      done = true;
      clearInterval(timer);
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (e) {}
        fd = null;
      }
      return { peak, reset, sampled: interval > 0, shared };
    },
  };
}

// The log words for a peak: peak=<bytes or unknown>, and what to make of it
function describe({ peak, reset, sampled, shared }) {
  if (peak === null) return "peak=unknown";
  if (shared && !reset) return `peak=unknown peak_since_create=${peak}`;
  return sampled ? `peak=${peak} peak_sampled=1` : `peak=${peak}`;
}

module.exports = { track, describe, SAMPLE_MS };
