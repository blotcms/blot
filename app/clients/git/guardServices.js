// Helpers for the git processes the git client starts for a request: one log
// line when each of them exits (see logExit), a tail of its stderr to put in
// that line, and a way to end one whose client has gone away (stop).
var debug = require("debug")("blot:clients:git:guardServices");
var clfdate = require("helper/clfdate");

// How much of the end of a process's stderr to keep for the exit line
var STDERR_TAIL_BYTES = 2048;

// Keeps only the last `limit` bytes it has been given, however many that is,
// so a chatty process can't make us hold on to its whole stderr.
function createTail(limit) {
  var tail = Buffer.alloc(0);

  return {
    add: function (chunk) {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(String(chunk));

      // Only the last `limit` bytes of the chunk can survive, so don't
      // concatenate more than that.
      if (chunk.length > limit) chunk = chunk.subarray(chunk.length - limit);

      tail = Buffer.concat([tail, chunk]);

      if (tail.length > limit) tail = tail.subarray(tail.length - limit);
    },
    toString: function () {
      return tail.toString("utf8");
    },
  };
}

// The pipes to a child process are sockets, which count their bytes
function streamBytes(stream, property) {
  try {
    return (stream && stream[property]) || 0;
  } catch (err) {
    return 0;
  }
}

// One line for the whole life of a process, in the style of the rest of Blot's
// logs: the request ID (to match it with the access log and the other lines of
// the same request), the service, the blog, how it exited, how long it ran, the
// bytes it was sent (rx, the request body once decompressed) and wrote (tx, the
// response), and the end of its stderr if it wrote any.
function formatExitLine(info) {
  var parts = [
    clfdate(),
    info.requestId || "no-request-id",
    "Git:",
    info.service || "unknown-service",
    info.handle || "unknown-handle",
    info.signal ? "exit=null signal=" + info.signal : "exit=" + info.code,
    "duration=" + (info.durationMs / 1000).toFixed(3) + "s",
    "rx=" + info.rx,
    "tx=" + info.tx,
  ];

  if (info.stderr) parts.push("stderr=" + JSON.stringify(info.stderr));

  return parts.join(" ");
}

// Logs how a git process finished. `request` carries the request it served
// (for its ID and handle) and `service` says which service it was.
function logExit(duplex, ps) {
  var startedAt = Date.now();
  var tail = createTail(STDERR_TAIL_BYTES);
  var exit = null;
  var logged = false;
  var timer = null;

  // Nothing else reads stderr, so this also stops a process which writes a lot
  // to it from blocking on a full pipe.
  if (ps.stderr) {
    ps.stderr.on("data", function (chunk) {
      tail.add(chunk);
    });
  }

  function log() {
    if (logged) return;
    logged = true;
    clearTimeout(timer);

    try {
      var request = duplex.request;

      console.log(
        formatExitLine({
          requestId:
            request && request.headers && request.headers["x-request-id"],
          service: duplex.service,
          handle: request && request.gitHandle,
          code: exit.code,
          signal: exit.signal,
          durationMs: exit.at - startedAt,
          rx: streamBytes(ps.stdin, "bytesWritten"),
          tx: streamBytes(ps.stdout, "bytesRead"),
          stderr: tail.toString(),
        })
      );
    } catch (err) {
      debug("Error logging git process exit", err);
    }
  }

  // "exit" fires when the process ends but its stderr may still be arriving, so
  // wait for "close" (all its stdio ended). A grandchild which inherited stderr
  // can keep that open, so don't wait for it for more than a moment.
  ps.on("exit", function (code, signal) {
    exit = { code: code, signal: signal, at: Date.now() };
    timer = setTimeout(log, 1000);
    if (timer.unref) timer.unref();
  });

  ps.on("close", function (code, signal) {
    if (!exit) exit = { code: code, signal: signal, at: Date.now() };
    log();
  });
}

// How long a git child gets to exit by itself once we have closed its input
// before we send it SIGTERM. Git normally exits within milliseconds.
var STOP_GRACE_MS = 5 * 1000;

function noop() {}

// A late write to a stdin we have destroyed (or a read from a stdout whose
// reader has gone) must not become an uncaught exception.
function ignoreStreamErrors(ps) {
  if (ps._blotStreamErrorsIgnored) return;

  ps._blotStreamErrorsIgnored = true;

  [ps.stdin, ps.stdout, ps.stderr].forEach(function (stream) {
    if (stream) stream.on("error", noop);
  });
}

function hasExited(ps) {
  return ps.exitCode !== null || ps.signalCode !== null;
}

// Ends a git child whose client has gone away. Closing its input gives it EOF,
// so upload-pack sees the end of its request and exits, and a git which was
// reading a pack fails with "early EOF" and cleans up after itself.
function stop(ps) {
  if (!ps || ps._blotStopping || hasExited(ps)) return;

  ps._blotStopping = true;

  ignoreStreamErrors(ps);

  try {
    if (ps.stdin) ps.stdin.destroy();
  } catch (err) {
    debug("Error closing git stdin", err);
  }

  // Backstop in case git does not exit when its input ends.
  var timer = setTimeout(function () {
    if (hasExited(ps)) return;

    debug("Git process did not exit after its input closed, killing it");

    try {
      ps.kill();
    } catch (err) {
      debug("Error killing git process", err);
    }
  }, STOP_GRACE_MS);

  timer.unref();

  ps.once("exit", function () {
    clearTimeout(timer);
  });
}

module.exports = {
  createTail: createTail,
  formatExitLine: formatExitLine,
  logExit: logExit,
  stop: stop,
  STDERR_TAIL_BYTES: STDERR_TAIL_BYTES,
};
