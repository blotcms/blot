// A real git client for the git client's specs: it spawns the `git` binary
// (child_process.execFile) and talks HTTP to the test server, the way a
// user's machine does. It does not use simple-git, so specs written with it
// keep working when the server side stops using simple-git too.
//
// A spec using this helper should only look at what a user can observe: the
// output of git commands run in a clone, the files in the blog folder (not
// its .git directory), Blot's models, and the client's public functions. It
// should not open the bare repository, the blog folder's .git directory or
// anything under data/git: those go away or move.
//
//   require("./setup")({ clone: false, client: true });
//
//   it("pushes", async function () {
//     await this.local.write("/hello.txt", "Hello");
//     await this.local.commit("Add hello");
//     await this.local.push();            // resolves once Blot has synced
//     await this.local.expectSynced();    // clone == blog folder == server
//   });

var childProcess = require("child_process");
var crypto = require("crypto");
var http = require("http");
var fs = require("fs-extra");
var path = require("path");
var dirCompare = require("dir-compare");

// How long to wait for one git command, and for Blot to finish syncing after
// a push. Both fail with a message rather than hanging the spec.
var COMMAND_TIMEOUT = 45 * 1000;
var SYNC_TIMEOUT = 40 * 1000;

// Between two polls of the syncs-finished route
var POLL_INTERVAL = 25;

function environment() {
  return Object.assign({}, process.env, {
    // Nothing from the machine running the specs may leak into git's
    // behaviour: no user config, no credential prompt, no pager, no locale
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
    LANG: "C",
    GIT_AUTHOR_NAME: "Blot Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Blot Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
}

// Runs git with the given arguments. Resolves with { stdout, stderr, code }
// whatever the exit code is, and rejects only if git could not be run at all
// or did not finish in time.
function attempt(args, options) {
  options = options || {};

  return new Promise(function (resolve, reject) {
    var child = childProcess.execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: Object.assign(environment(), options.env || {}),
        encoding: options.encoding || "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: options.timeout || COMMAND_TIMEOUT,
        killSignal: "SIGKILL",
      },
      function (err, stdout, stderr) {
        if (err && typeof err.code !== "number") {
          var reason = err.killed
            ? "did not finish within " + (options.timeout || COMMAND_TIMEOUT) + "ms"
            : err.message;
          return reject(
            new Error("git " + args.join(" ") + " " + reason + "\n" + stderr)
          );
        }

        resolve({ stdout: stdout, stderr: stderr, code: err ? err.code : 0 });
      }
    );

    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

// As attempt(), but rejects if git exits with a non-zero code. The error
// carries stdout, stderr and code.
function run(args, options) {
  return attempt(args, options).then(function (result) {
    if (result.code === 0) return result;

    var err = new Error(
      "git " + args.join(" ") + " exited with code " + result.code + "\n" + result.stderr
    );
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    err.code = result.code;
    throw err;
  });
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function get(url) {
  return new Promise(function (resolve, reject) {
    http
      .get(url, function (res) {
        var body = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          body += chunk;
        });
        res.on("end", function () {
          resolve(body);
        });
      })
      .on("error", reject);
  });
}

// Every file under a directory as { "relative/path": Buffer }, ignoring
// anything inside a .git directory.
async function readTree(directory) {
  var result = {};

  async function walk(relative) {
    var entries = await fs.readdir(path.join(directory, relative), {
      withFileTypes: true,
    });

    for (var entry of entries) {
      if (entry.name === ".git") continue;

      var child = path.join(relative, entry.name);

      if (entry.isDirectory()) {
        await walk(child);
      } else {
        result[child] = await fs.readFile(path.join(directory, child));
      }
    }
  }

  await walk("");

  return result;
}

// Every directory under a directory (not the directory itself), ignoring
// anything inside a .git directory.
async function readDirectories(directory) {
  var result = [];

  async function walk(relative) {
    var entries = await fs.readdir(path.join(directory, relative), {
      withFileTypes: true,
    });

    for (var entry of entries) {
      if (entry.name === ".git" || !entry.isDirectory()) continue;

      var child = path.join(relative, entry.name);
      result.push(child);
      await walk(child);
    }
  }

  await walk("");

  return result.sort();
}

// A clone of a test blog's repository, and the blog it belongs to.
//
//   directory      where the clone is on disk
//   url            the remote's URL, credentials included
//   port           the port of the test server, for syncs-finished
//   blogID         the blog
//   blogDirectory  the blog's folder, where Blot syncs the repository to
//   config         `-c key=value` pairs added to every git command
function Client(options) {
  this.directory = options.directory;
  this.url = options.url;
  this.port = options.port;
  this.blogID = options.blogID;
  this.blogDirectory = options.blogDirectory;
  this.config = options.config || {};
}

// Makes a clone of the remote in a new directory and resolves with its Client.
//
//   options.directory  where to clone to (required)
//   options.url, options.port, options.blogID, options.blogDirectory
//   options.args       extra arguments for `git clone`, e.g. ["--depth", "1"]
//   options.config     `-c key=value` pairs for the clone and later commands
Client.clone = async function (options) {
  var client = new Client(options);
  var config = [];

  Object.keys(client.config).forEach(function (key) {
    config.push("-c", key + "=" + client.config[key]);
  });

  await fs.ensureDir(path.dirname(options.directory));
  await run(
    config.concat(["clone"], options.args || [], [options.url, options.directory])
  );

  return client;
};

// Makes the clone for a spec context, as set up by ./index.js (with the
// `client` option): ctx.repoUrl, ctx.server, ctx.blog and ctx.tmp.
Client.forContext = function (ctx, overrides) {
  return Client.clone(
    Object.assign(
      {
        directory: path.join(ctx.tmp, "clone-" + crypto.randomBytes(4).toString("hex")),
        url: ctx.repoUrl,
        port: ctx.server.port,
        blogID: ctx.blog.id,
        blogDirectory: ctx.blogDirectory,
      },
      overrides
    )
  );
};

// A second, independent clone of the same remote
Client.prototype.cloneAgain = function (overrides) {
  return Client.clone(
    Object.assign(
      {
        directory: path.join(
          path.dirname(this.directory),
          "clone-" + crypto.randomBytes(4).toString("hex")
        ),
        url: this.url,
        port: this.port,
        blogID: this.blogID,
        blogDirectory: this.blogDirectory,
        config: this.config,
      },
      overrides
    )
  );
};

Client.prototype._args = function (args) {
  var config = [];
  var client = this;

  Object.keys(this.config).forEach(function (key) {
    config.push("-c", key + "=" + client.config[key]);
  });

  return config.concat(args);
};

// Runs a git command in the clone, rejects if it fails
Client.prototype.git = function (args, options) {
  return run(this._args(args), Object.assign({ cwd: this.directory }, options));
};

// Runs a git command in the clone, resolves with { stdout, stderr, code }
// even if git fails. For commands which a spec expects to be refused.
Client.prototype.try = function (args, options) {
  return attempt(this._args(args), Object.assign({ cwd: this.directory }, options));
};

Client.prototype.path = function (file) {
  return path.join(this.directory, file);
};

// Writes a file in the working tree, creating its folders
Client.prototype.write = function (file, content) {
  return fs.outputFile(this.path(file), content);
};

Client.prototype.remove = function (file) {
  return fs.remove(this.path(file));
};

Client.prototype.read = function (file) {
  return fs.readFile(this.path(file));
};

// Stages everything (new, changed and removed files) and commits it
Client.prototype.commit = async function (message, options) {
  options = options || {};

  await this.git(["add", "--all"]);
  await this.git(
    ["commit", "--quiet", "--message", message || "Commit"].concat(
      options.allowEmpty ? ["--allow-empty"] : []
    )
  );
};

// Writes files then commits them. files is { "/path": content }.
Client.prototype.commitFiles = async function (files, message) {
  for (var file of Object.keys(files)) await this.write(file, files[file]);

  await this.commit(message || "Update " + Object.keys(files).join(", "));
};

// Commits and pushes a single file, the common case
Client.prototype.writeAndPush = async function (file, content) {
  await this.commitFiles({ [file]: content });
  return this.push();
};

// The commit the clone is at
Client.prototype.head = async function () {
  return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
};

// The commit the server has for a branch (null if it has none), as seen by
// `git ls-remote`. This is how specs look at the server's side: they never
// open the repository itself.
Client.prototype.remoteHead = async function (branch) {
  var ref = "refs/heads/" + (branch || "master");
  var output = (await this.git(["ls-remote", "origin", ref])).stdout.trim();

  if (!output) return null;

  return output.split(/\s+/)[0];
};

// Pushes, refusing nothing: resolves with { stdout, stderr, code } whether
// or not the server accepted the push, and does not wait for Blot to sync.
// By default it pushes the local master to the remote's master.
Client.prototype.tryPush = function (args) {
  return this.try(["push"].concat(args || ["origin", "master"]));
};

// Pushes and waits until Blot has finished syncing the blog folder. Rejects if
// the push fails (use tryPush to look at a refused push) or if the sync has
// not finished before the deadline. Resolves with { stdout, stderr, code }.
Client.prototype.push = async function (args, options) {
  var result = await this.git(["push"].concat(args || ["origin", "master"]));

  // Nothing was sent, so there is no sync to wait for
  if (!/Everything up-to-date/.test(result.stderr)) {
    await this.waitForSync(options);
  }

  return result;
};

// Waits until Blot says it has no sync running or waiting for this blog, using
// the test-only route the git client exposes. It must see "true" twice in a
// row, a moment apart, so that a sync which was about to start is not missed.
Client.prototype.waitForSync = async function (options) {
  var timeout = (options && options.timeout) || SYNC_TIMEOUT;
  var deadline = Date.now() + timeout;
  var url =
    "http://127.0.0.1:" + this.port + "/clients/git/syncs-finished/" + this.blogID;
  var finished = 0;

  while (finished < 2) {
    if (Date.now() > deadline) {
      throw new Error(
        "Blot did not finish syncing blog " + this.blogID + " within " + timeout + "ms"
      );
    }

    finished = (await get(url)) === "true" ? finished + 1 : 0;

    await sleep(POLL_INTERVAL);
  }
};

// Fetches and merges (or rebases) what the server has
Client.prototype.pull = function (args) {
  return this.git(["pull"].concat(args || ["origin", "master"]));
};

// Every file in the clone's working tree as { "relative/path": Buffer }
Client.prototype.tree = function () {
  return readTree(this.directory);
};

// Asserts that the clone's HEAD is the server's master, and that the blog
// folder on Blot's side has exactly the files of the clone's working tree
// (the .git directories are not compared). Rejects with a description if not.
Client.prototype.expectSynced = async function () {
  var local = await this.head();
  var remote = await this.remoteHead("master");

  if (local !== remote) {
    throw new Error(
      "The clone is at " + local + " but the server's master is at " + remote
    );
  }

  await compareDirectories(this.directory, this.blogDirectory);
};

function compareDirectories(expected, actual) {
  return dirCompare
    .compare(expected, actual, {
      compareSize: true,
      compareContent: true,
      excludeFilter: ".git",
    })
    .then(function (res) {
      if (!res.differences) return;

      var message = [
        "The blog folder is not the same as the clone (" + res.differences + " differences):",
      ];

      res.diffSet.forEach(function (entry) {
        if (entry.state === "equal") return;

        message.push(
          "  " +
            (entry.relativePath || "") +
            "/" +
            (entry.name1 || entry.name2) +
            " (" +
            entry.state +
            ": only in " +
            ({ left: "clone", right: "blog folder", distinct: "both, different" }[
              entry.state
            ] || entry.state) +
            ")"
        );
      });

      throw new Error(message.join("\n"));
    });
}

// A tiny HTTP proxy in front of the test server which records every request
// it forwards (method, URL, headers), so a spec can check how a real git
// client sent its request, e.g. whether the body was gzipped or chunked.
//
//   var proxy = await startRecordingProxy(ctx.server.port);
//   var client = await Client.forContext(ctx, { url: proxy.rewrite(ctx.repoUrl) });
//   ...
//   proxy.requests.filter(...)
//   await proxy.close();
function startRecordingProxy(targetPort) {
  var requests = [];
  var sockets = new Set();

  var server = http.createServer(function (req, res) {
    requests.push({ method: req.method, url: req.url, headers: Object.assign({}, req.headers) });

    var headers = Object.assign({}, req.headers);
    headers.host = "127.0.0.1:" + targetPort;
    delete headers.connection;

    var upstream = http.request(
      { host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: headers },
      function (response) {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      }
    );

    upstream.on("error", function () {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });

    req.pipe(upstream);
  });

  server.on("connection", function (socket) {
    sockets.add(socket);
    socket.on("close", function () {
      sockets.delete(socket);
    });
  });

  return new Promise(function (resolve, reject) {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", function () {
      var port = server.address().port;

      resolve({
        port: port,
        requests: requests,
        // The same URL, pointing at the proxy
        rewrite: function (url) {
          var rewritten = new URL(url);
          rewritten.port = String(port);
          return rewritten.toString();
        },
        close: function () {
          return new Promise(function (done) {
            sockets.forEach(function (socket) {
              socket.destroy();
            });
            server.close(function () {
              done();
            });
          });
        },
      });
    });
  });
}

module.exports = Client;
module.exports.attempt = attempt;
module.exports.run = run;
module.exports.readTree = readTree;
module.exports.readDirectories = readDirectories;
module.exports.compareDirectories = compareDirectories;
module.exports.startRecordingProxy = startRecordingProxy;
