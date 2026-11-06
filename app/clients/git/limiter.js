// How much git this process runs at once, and the memory each git command may
// take. Every git process the git client starts goes through here.
//
// On 2 Nov 2026 a template migration wrote 1,990 files back to blogs. On git
// blogs each one was a commit, a fetch into a live clone and a `gc --auto`,
// all started at once: about 60 git processes held 1.24 GB between them, the
// unit reached its memory limit and the kernel killed one of its Node
// processes. Git shares the unit's cgroup with both Node processes, so nothing
// but this stops a burst of it from doing that again.
//
// Two lanes, each with its own cap, so neither waits behind the other:
//
//   interactive  what a user is waiting on: pushes (index-pack and the checks
//                after it), clones and fetches
//   background   Blot's own commits, compaction, and the import of a new
//                repository
//
// A command holds its place from just before it is spawned until it has
// closed (its pipes too, so the processes it started have exited), however
// it ends. Work beyond the cap waits in a queue, in order. A waiting command
// is a closure and a promise, a few hundred bytes; the caller is waiting on
// it anyway and holds whatever it is writing. Nothing is dropped from the
// queue: a write which failed to commit would leave the blog folder and the
// repository apart.
//
//   limiter.run(lane, start)   start() spawns the command and returns a
//                              promise which settles once it has closed; run
//                              returns that promise, and calls start once
//                              there is room
//   limiter.gate(lane)         the same, as the gate the git store takes
//   limiter.args(args)         git's arguments with the memory settings in
//                              front
//
// A run inside another run (in the same async context, while the outer one
// still holds its place) does not wait again: Blot's commit holds one place
// in the background lane while it holds the ref lock and runs its commands one
// after another, so it never waits for room with the lock held.
const { AsyncLocalStorage } = require("async_hooks");
const clfdate = require("helper/clfdate");
const config = require("config");

// What every git command runs with, passed with -c so they hold whatever the
// system config says (the Docker image sets some of these too). They bound the
// memory of one git process to about 100 MB:
//
//   pack.windowMemory      16m  the delta search window of pack-objects, per
//                               thread
//   pack.deltaCacheSize    16m  deltas pack-objects keeps to write
//   pack.threads            1   so the two above are not per core
//   core.deltaBaseCacheLimit 16m  delta bases kept inflated, by every reader
//   core.bigFileThreshold  16m  a blob larger than this is streamed and never
//                               held whole or delta-compressed
//   core.packedGitLimit    64m  pack data mapped at once (file-backed pages,
//                               which the kernel can reclaim)
//   core.packedGitWindowSize 16m  each mapping of a pack
//
// So about 16 + 16 + 16 + 16 (and the blob's compressed copy) of heap, plus
// pack-objects' bookkeeping for each object (a few hundred bytes, so tens of
// MB in a repository of a hundred thousand objects), plus up to 64 MB mapped.
// None of them changes what an object, a commit or a tree is, so commit IDs
// are the same; packs may delta differently, which no reader of them depends
// on.
const MEMORY = [
  ["pack.threads", "1"],
  ["pack.windowMemory", "16m"],
  ["pack.deltaCacheSize", "16m"],
  ["core.deltaBaseCacheLimit", "16m"],
  ["core.bigFileThreshold", "16m"],
  ["core.packedGitLimit", "64m"],
  ["core.packedGitWindowSize", "16m"],
];

// No command starts a gc, or maintenance: they would run outside the limiter
// (detached, after the command has exited). The store compacts its packs
// itself.
const NO_AUTO_GC = [
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
];

function flags(pairs) {
  const out = [];
  pairs.forEach(function (pair) {
    out.push("-c", pair[0] + "=" + pair[1]);
  });
  return out;
}

const MEMORY_FLAGS = flags(MEMORY);
const NO_AUTO_GC_FLAGS = flags(NO_AUTO_GC);

// git's subcommand: the first argument which is not an option of git itself
function subcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "-C") {
      i++;
      continue;
    }
    if (args[i].indexOf("-") !== 0) return args[i];
  }
  return null;
}

// The arguments with the settings in front. `git config` is left alone: it
// reads and writes config, and a -c would be what it reads back.
function args(list) {
  const command = subcommand(list);

  if (command === "config") return list;

  return MEMORY_FLAGS.concat(NO_AUTO_GC_FLAGS, list);
}

// A queue with a cap on how many hold a place at once
function createLane(name, max) {
  const lane = {
    name: name,
    max: Math.max(1, max),
    running: 0,
    waiting: [],
    started: 0,
    peak: 0,
    warned: false,
  };

  lane.acquire = function () {
    return new Promise(function (resolve) {
      lane.waiting.push(resolve);
      pump(lane);

      if (!lane.warned && lane.waiting.length >= WARN_QUEUE) {
        lane.warned = true;
        console.log(clfdate(), "Git: " + lane.waiting.length + " " + name + " commands waiting for room");
      }
    });
  };

  return lane;
}

// A queue this long is logged, once until it empties
const WARN_QUEUE = 100;

function pump(lane) {
  while (lane.running < lane.max && lane.waiting.length) {
    const resolve = lane.waiting.shift();
    let released = false;

    lane.running++;
    lane.started++;
    lane.peak = Math.max(lane.peak, lane.running);

    resolve(function release() {
      if (released) return;
      released = true;
      lane.running--;
      pump(lane);
    });
  }

  if (lane.warned && !lane.waiting.length) {
    lane.warned = false;
    console.log(clfdate(), "Git: no " + lane.name + " commands waiting");
  }
}

const LANES = ["interactive", "background"];

function createLimiter(options) {
  const held = new AsyncLocalStorage();
  const lanes = {};

  function configure(caps) {
    lanes.interactive = createLane("interactive", caps.interactive);
    lanes.background = createLane("background", caps.background);
  }

  configure(options);

  // Resolves with a function which gives the place back
  async function acquire(lane) {
    if (LANES.indexOf(lane) === -1) throw new Error("No git lane called " + lane);

    return lanes[lane].acquire();
  }

  function run(lane, start) {
    const outer = held.getStore();

    if (outer && outer.holding) return Promise.resolve().then(start);

    return acquire(lane).then(function (release) {
      const place = { holding: true };

      return new Promise(function (resolve) {
        held.run(place, function () {
          resolve(Promise.resolve().then(start));
        });
      }).finally(function () {
        place.holding = false;
        release();
      });
    });
  }

  // Runs fn outside any place this context holds, so what it starts (a sync
  // after a push, say) waits for room of its own
  function outside(fn) {
    return held.exit(fn);
  }

  // A function the git store (store/) takes as its gate: see store/README
  function gate(lane) {
    return function (start) {
      return run(lane, start);
    };
  }

  function stats() {
    const out = {};
    Object.keys(lanes).forEach(function (name) {
      const lane = lanes[name];
      out[name] = { max: lane.max, running: lane.running, waiting: lane.waiting.length, started: lane.started, peak: lane.peak };
    });
    return out;
  }

  // For specs: new caps, and counts from zero. Anything holding a place in the
  // old lanes gives it back to them.
  function reset(caps) {
    configure(Object.assign(currentCaps(), caps));
  }

  function currentCaps() {
    return { interactive: lanes.interactive.max, background: lanes.background.max };
  }

  return { run, acquire, outside, gate, stats, reset, args, subcommand };
}

// This process's limiter. Each Node process of a unit has its own, so a unit
// runs at most twice these. See config/index.js for the numbers.
module.exports = createLimiter({
  interactive: config.git.interactive_processes,
  background: config.git.background_processes,
});

module.exports.createLimiter = createLimiter;
module.exports.MEMORY = MEMORY;
