// Serves git's smart HTTP protocol. The read side (ref advertisement and
// upload-pack, so clones and fetches) runs `git upload-pack` directly; the
// write side is receivePack.js. Everything else (dumb HTTP, unknown paths,
// wrong methods) is answered here with the statuses and bodies pushover gave.
//
// This stays on protocol v0, as pushover did: the Git-Protocol header is never
// passed on and GIT_PROTOCOL is removed from git's environment, so a client
// asking for version 2 gets a v0 advertisement and falls back. The
// advertisement is whatever stock upload-pack offers with the repository's
// config, which only Blot writes (a push can't change it), so it holds
// nothing we don't implement.
var fs = require("fs");
var zlib = require("zlib");
var spawn = require("child_process").spawn;
var querystring = require("querystring");
var debug = require("debug")("blot:clients:git:smartHttp");
var guardServices = require("./guardServices");
var receivePack = require("./receivePack");

var noCache = receivePack.noCache;

function noop() {}

function env() {
  var copy = Object.assign({}, process.env);

  delete copy.GIT_PROTOCOL;

  return copy;
}

function fail(res, err) {
  debug("Error running git upload-pack", err);

  if (!res.headersSent) {
    res.statusCode = 500;
    res.end();
  } else {
    res.destroy();
  }
}

// GET /<handle>.git/info/refs?service=git-upload-pack
function advertise(req, res, directory) {
  res.setHeader("connection", "close");

  fs.access(directory, function (err) {
    if (err) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      return res.end("repository not found");
    }

    res.setHeader(
      "content-type",
      "application/x-git-upload-pack-advertisement"
    );
    noCache(res);

    var ps = spawn(
      "git",
      ["upload-pack", "--stateless-rpc", "--advertise-refs", directory],
      { env: env(), stdio: ["ignore", "pipe", "ignore"] }
    );

    ps.on("error", function (err) {
      fail(res, err);
    });

    res.write(Buffer.concat([receivePack.pktLine("# service=git-upload-pack\n"), Buffer.from("0000")]));
    ps.stdout.on("error", noop);
    ps.stdout.pipe(res);

    // The client left before the advertisement was finished
    res.once("close", function () {
      if (res.writableFinished) return;
      ps.stdout.unpipe(res);
      ps.kill();
    });
  });
}

// POST /<handle>.git/git-upload-pack. Git's 0000 probe (sent before a request
// larger than http.postBuffer) needs no special case: upload-pack reads the
// flush packet, has nothing to send, and exits, so the answer is an empty 200,
// as git http-backend gives.
function fetch(req, res, directory) {
  res.setHeader("connection", "close");
  res.setHeader("content-type", "application/x-git-upload-pack-result");
  noCache(res);

  var ps = spawn("git", ["upload-pack", "--stateless-rpc", directory], {
    env: env(),
  });
  var source = req;
  var gunzip;
  var rejected = false;

  // Logs how the process ended and reads its stderr
  guardServices.logExit({ service: "upload-pack", request: req }, ps);

  ps.on("error", function (err) {
    fail(res, err);
  });

  ps.stdout.on("error", noop);

  // Git does not always read the whole request. Drain the rest so the client
  // can still read the response.
  ps.stdin.on("error", function () {
    source.unpipe(ps.stdin);
    source.resume();
  });

  if (req.headers["content-encoding"] === "gzip") {
    gunzip = source = zlib.createGunzip();

    // A body which isn't valid gzip must end this request, not the process
    gunzip.on("error", function (err) {
      if (rejected) return;
      rejected = true;

      debug("Bad gzip request body", err.message);
      guardServices.stop(ps);
      ps.stdout.unpipe(res);
      ps.stdout.resume();
      req.unpipe(gunzip);
      req.resume();

      if (res.headersSent) return res.destroy();

      res.statusCode = 400;
      res.setHeader("content-type", "text/plain");
      res.end("bad request body");
    });

    req.pipe(gunzip);
  }

  source.pipe(ps.stdin);
  ps.stdout.pipe(res);

  // The client has gone: stop git rather than leave it waiting for the rest
  // of the request or blocked writing a response nobody reads.
  function abandon() {
    guardServices.stop(ps);
  }

  req.once("aborted", abandon);
  req.once("error", abandon);

  res.once("close", function () {
    if (res.writableFinished) return;
    ps.stdout.unpipe(res);
    ps.stdout.destroy();
    abandon();
  });
}

function reply(res, status, body) {
  res.statusCode = status;
  res.end(body);
}

// GET /<handle>.git/HEAD, which dumb HTTP clients ask for
function head(res, directory) {
  fs.access(directory, function (err) {
    if (err) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      return res.end("repository not found");
    }

    fs.readFile(directory + "/HEAD", function (err, contents) {
      if (err) return reply(res, 404, "not found");
      res.end(contents);
    });
  });
}

// Answers the request. The request has been authenticated, req.gitHandle is
// the handle parsed by routes.js and directory is that handle's repository;
// neither comes from the rest of the URL. receive is passed to receivePack.
function handle(req, res, directory, receive) {
  var url = req.url;
  var query = url.indexOf("?");
  var pathname = query === -1 ? url : url.slice(0, query);
  var repository = "/" + req.gitHandle + ".git";

  res.setHeader("connection", "close");

  if (!req.gitHandle) return reply(res, 404, "not found");

  if (req.method === "GET" && pathname === repository + "/info/refs") {
    var service = querystring.parse(query === -1 ? "" : url.slice(query + 1)).service;

    if (!service || typeof service !== "string") {
      return reply(res, 400, "service parameter required");
    }

    service = service.replace(/^git-/, "");

    if (service === "upload-pack") return advertise(req, res, directory);
    if (service === "receive-pack") return receivePack.advertise(req, res, directory);

    return reply(res, 405, "service not available");
  }

  if (req.method === "GET" && pathname === repository + "/HEAD") return head(res, directory);

  if (req.method === "POST") {
    if (url === repository + "/git-upload-pack") return fetch(req, res, directory);

    if (url === repository + "/git-receive-pack") {
      return receivePack.handle(req, res, Object.assign({ directory: directory, handle: req.gitHandle }, receive));
    }

    // Any other service, or a query string (which pushover read as part of
    // the service's name)
    if (url.indexOf(repository + "/git-") === 0 && url.length > repository.length + 5) {
      return reply(res, 405, "service not available");
    }
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return reply(res, 405, "method not supported");
  }

  reply(res, 404, "not found");
}

module.exports = { handle: handle };
