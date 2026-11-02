// `git gc --auto` for a bare repository, after Blot's commits and users'
// pushes. A commit leaves loose objects and a push a pack, so without it a
// repository would never be packed; with nothing to do, gc --auto only counts
// files and exits.
//
// It used to be spawned, detached, after every commit and every push. A burst
// of writes to one blog then started a gc for each, and git 2.54 lets them
// overlap (see create.js). Now:
//
//   - a commit or push asks for one (schedule), and it runs `delay` later, so
//     a burst of writes to a repository within that time makes one gc
//   - at most one runs for a repository at a time in this process: asked for
//     while one runs, another runs once that has finished (and only one, however
//     many asked meanwhile)
//   - it runs in the background lane in the foreground of its own process
//     (gc.autoDetach=false), so the limiter counts it until it has finished,
//     and at most config.git.gc_processes run at once in this process
//
// A gc asked for and not yet run is a timer and an entry in a map, until it
// runs. One lost to a restart costs nothing: the next commit or push asks
// again, and gc --auto packs whatever has built up by then.
const { spawn } = require("child_process");
const clfdate = require("helper/clfdate");
const config = require("config");
const limiter = require("./limiter");

const TIMEOUT_MS = 60 * 60 * 1000;

// directory -> { timer, running, again }
const repositories = new Map();

// Waiting for the gcs running or due, for specs
let idle = [];

const settings = { delay: config.git.gc_delay };

function schedule(directory) {
  let state = repositories.get(directory);

  if (!state) {
    state = { timer: null, running: false, again: false };
    repositories.set(directory, state);
  }

  if (state.running) {
    state.again = true;
    return;
  }

  if (state.timer) return;

  state.timer = setTimeout(function () {
    state.timer = null;
    start(directory, state);
  }, settings.delay);

  state.timer.unref();
}

function start(directory, state) {
  state.running = true;
  state.again = false;

  // Not inside whatever asked for it: the gc waits for room of its own
  limiter.outside(function () {
    return run(directory);
  })
    .catch(function (err) {
      console.error(clfdate(), "Git: gc failed in", directory, err.message);
    })
    .then(function () {
      state.running = false;

      if (state.again) {
        state.again = false;
        return schedule(directory);
      }

      repositories.delete(directory);
      settle();
    });
}

function run(directory) {
  const args = limiter.args(["gc", "--auto", "--quiet"]);

  return limiter.run(
    "background",
    function () {
      return new Promise(function (resolve, reject) {
        const child = spawn("git", args, {
          cwd: directory,
          env: Object.assign({}, process.env, { GIT_DIR: directory }),
          stdio: ["ignore", "ignore", "pipe"],
          timeout: TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
        let stderr = "";

        child.stderr.on("data", function (chunk) {
          if (stderr.length < 4096) stderr += chunk;
        });
        child.on("error", function (err) {
          // Not started (the repository has gone, say): there is no close
          if (child.pid === undefined) reject(err);
        });
        child.on("close", function (code) {
          if (code) return reject(new Error(stderr.trim() || "exit " + code));
          resolve();
        });
      });
    },
    { gc: true }
  );
}

function settle() {
  if (repositories.size) return;

  const waiting = idle;
  idle = [];
  waiting.forEach(function (resolve) {
    resolve();
  });
}

// For specs: runs every gc that is due now, and resolves once none is due or
// running
function flush() {
  repositories.forEach(function (state, directory) {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
    start(directory, state);
  });

  return drained();
}

// Resolves once no gc is due or running
function drained() {
  if (!repositories.size) return Promise.resolve();

  return new Promise(function (resolve) {
    idle.push(resolve);
  });
}

module.exports = { schedule, flush, drained, settings };
