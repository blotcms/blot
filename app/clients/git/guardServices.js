// Pushover builds an http-duplex object for every Git request it handles (the
// "Service" for POSTs to git-receive-pack and git-upload-pack, and a plain
// duplex for GET info/refs and HEAD). http-duplex forwards the request's
// events onto that object with req.on("error", self.emit.bind(self, "error")),
// so if a client disconnects before the response has finished (for example
// partway through a very large push) the request errors with "aborted" and the
// error is re-emitted on the duplex. An EventEmitter with no "error" listener
// throws, which takes down the whole process and every other request with it.
//
// Pushover only hands us the object later, and only for some requests: "push"
// is emitted once the first chunk of the body names a branch, but tag pushes,
// fetches, git's 0000 probe and bodies whose first chunk doesn't parse never
// reach a listener we control (or are accepted without one). Rather than try to
// catch every path, give each duplex an error listener at the moment it is
// constructed by installing it on http-duplex itself.
//
// This must be required before pushover is used, but it patches the shared
// prototype so it does not matter whether pushover has already been loaded.
//
// The same hook is where we can see the child process of every push and fetch,
// so it also logs one line when each of them exits (see logExit). Pushover pipes
// the child's stdout to the response but never reads its stderr or looks at how
// it exited, so a process failing early was invisible.
var path = require("path");
var debug = require("debug")("blot:clients:git:routes");
var clfdate = require("helper/clfdate");

var HttpDuplex = require(
  require.resolve("http-duplex", {
    paths: [path.dirname(require.resolve("pushover"))],
  })
);

var processKey = "_blotGitProcess";

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

// Logs how a git process finished.
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

function isConnectionError(err) {
  return err && (err.code === "ECONNRESET" || err.code === "EPIPE");
}

// Pushover pipes a legacy `through` stream into the child's stdin and the
// child's stdout out to the response. A legacy pipe throws if its destination
// errors and nothing else is listening, so a late write to a stdin we have
// destroyed (or a read from a stdout whose reader has gone) would otherwise
// become an uncaught exception.
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

// Ends a git child whose client has gone away.
//
// Signalling it is not enough. git-receive-pack hands the pack to
// `git index-pack --stdin`, which inherits receive-pack's stdin: the pipe from
// us. Killing receive-pack leaves index-pack (hundreds of MB of RSS for a big
// push) blocked reading a pipe that we still hold open, and the push's
// quarantine directory (objects/tmp_objdir-incoming-*) stays on disk. Closing
// the pipe instead gives every reader EOF: index-pack fails with "early EOF",
// receive-pack reports the failure, deletes the quarantine directory and
// exits; upload-pack sees the end of its request and exits.
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

function onError(duplex, err) {
  if (isConnectionError(err)) {
    debug("Git connection error", err.message || err);
  } else {
    debug("Git unexpected error", err);
  }

  // The client has gone (or the response failed), so nothing will ever finish
  // reading the request body. Stop the git subprocess pushover may have started
  // for it rather than leaving it waiting on stdin forever.
  stop(duplex[processKey]);
}

function guard(duplex) {
  duplex.on("service", function (ps) {
    duplex[processKey] = ps;
    ignoreStreamErrors(ps);
    logExit(duplex, ps);

    // A client that hangs up while git is still sending (a clone or fetch)
    // closes the response without an error, and the response then never
    // drains: git would block writing to a full pipe indefinitely.
    var res = duplex.response;

    if (res && typeof res.once === "function") {
      res.once("close", function () {
        if (!res.writableFinished) stop(ps);
      });
    }
  });

  duplex.on("error", function (err) {
    onError(duplex, err);
  });
}

function install() {
  var proto = HttpDuplex.prototype;

  if (proto._blotGuarded) return;

  // http-duplex's constructor starts with `self.request = req` before it
  // forwards any events, so intercept that assignment with an accessor on the
  // prototype. The constructor still ends up with an ordinary own property.
  Object.defineProperty(proto, "request", {
    configurable: true,
    get: function () {},
    set: function (req) {
      Object.defineProperty(this, "request", {
        value: req,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      guard(this);
    },
  });

  Object.defineProperty(proto, "_blotGuarded", { value: true });
}

install();

module.exports = {
  createTail: createTail,
  formatExitLine: formatExitLine,
  logExit: logExit,
  STDERR_TAIL_BYTES: STDERR_TAIL_BYTES,
};
