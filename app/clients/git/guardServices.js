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
var path = require("path");
var debug = require("debug")("blot:clients:git:routes");

var HttpDuplex = require(
  require.resolve("http-duplex", {
    paths: [path.dirname(require.resolve("pushover"))],
  })
);

var processKey = "_blotGitProcess";

function isConnectionError(err) {
  return err && (err.code === "ECONNRESET" || err.code === "EPIPE");
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
  var ps = duplex[processKey];
  if (ps && ps.exitCode === null && !ps.killed) {
    try {
      ps.kill();
    } catch (err) {
      debug("Error stopping git process", err);
    }
  }
}

function guard(duplex) {
  duplex.on("service", function (ps) {
    duplex[processKey] = ps;
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
