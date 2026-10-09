describe("git client aborted requests", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")();

  var fs = require("fs-extra");
  var http = require("http");
  var net = require("net");
  var url = require("url");
  var crypto = require("crypto");
  var childProcess = require("child_process");
  var spawn = childProcess.spawn;
  var dataDir = require("clients/git/dataDir");

  // Pushover wraps every Git request in an http-duplex object that re-emits
  // the request's errors. A client dropping its connection part way through a
  // request used to throw an unhandled 'error' event for any request that
  // pushover did not report as a branch push, which killed the whole process
  // (and every other request in flight with it). These specs abort requests of
  // each kind and check the server carries on, and that git itself winds down:
  // no git process left waiting on a client that has gone, and no quarantine
  // directory left behind in the repository.

  // Roughly 24MB of random (so incompressible) data across a few files.
  var BIG_FILES = 3;
  var BIG_FILE_BYTES = 8 * 1024 * 1024;

  // Let the server notice the dropped connection before we check on it.
  var SETTLE_MS = 1000;

  // How long git has to wind down once its client has gone away. The server
  // closes git's input straight away, so this only needs to cover git
  // noticing, cleaning up and exiting.
  var CLEANUP_MS = 10 * 1000;

  beforeEach(function () {
    var ctx = this;

    ctx.uncaught = [];
    ctx.onUncaught = function (err) {
      ctx.uncaught.push(err);
    };

    // If the server throws an unhandled error the test runner is the process
    // that receives it, so record it here to make the failure explicit.
    process.on("uncaughtException", ctx.onUncaught);

    ctx.proxies = [];
  });

  afterEach(function (done) {
    var ctx = this;

    process.removeListener("uncaughtException", ctx.onUncaught);

    var pending = ctx.proxies.length;

    if (!pending) return done();

    ctx.proxies.forEach(function (proxy) {
      proxy.close(function () {
        if (!--pending) done();
      });
    });
  });

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // A TCP proxy in front of the test server which destroys the connection
  // once enough bytes have passed through it. This is how we abort a real
  // `git` client part way through a request or response without needing to
  // time a kill of the git process.
  //   fromClient: destroy after this many bytes have been sent to the server
  //   fromServer: destroy after this many bytes have been sent to the client
  function startAbortingProxy(ctx, limits, callback) {
    var sockets = new Set();
    var proxy = net.createServer(function (client) {
      var upstream = net.connect(ctx.server.port, "127.0.0.1");
      var fromClient = 0;
      var fromServer = 0;

      sockets.add(client);
      sockets.add(upstream);

      function abort() {
        client.destroy();
        upstream.destroy();
      }

      client.on("error", function () {});
      upstream.on("error", function () {});

      client.on("data", function (chunk) {
        fromClient += chunk.length;
        if (limits.fromClient && fromClient >= limits.fromClient) {
          proxy.aborted = true;
          return abort();
        }
        upstream.write(chunk);
      });

      upstream.on("data", function (chunk) {
        fromServer += chunk.length;
        if (limits.fromServer && fromServer >= limits.fromServer) {
          proxy.aborted = true;
          return abort();
        }
        client.write(chunk);
      });

      client.on("end", function () {
        upstream.end();
      });
      upstream.on("end", function () {
        client.end();
      });
      client.on("close", function () {
        sockets.delete(client);
        upstream.destroy();
      });
      upstream.on("close", function () {
        sockets.delete(upstream);
        client.destroy();
      });
    });

    proxy.aborted = false;
    proxy.listen(0, "127.0.0.1", function () {
      var originalClose = proxy.close.bind(proxy);

      proxy.close = function (done) {
        sockets.forEach(function (socket) {
          socket.destroy();
        });
        originalClose(done);
      };

      proxy.repoUrl = ctx.repoUrl.replace(
        "127.0.0.1:" + ctx.server.port + "/",
        "127.0.0.1:" + proxy.address().port + "/"
      );

      ctx.proxies.push(proxy);
      callback(null, proxy);
    });
  }

  function startProxy(ctx, limits) {
    return new Promise(function (resolve, reject) {
      startAbortingProxy(ctx, limits, function (err, proxy) {
        if (err) return reject(err);
        resolve(proxy);
      });
    });
  }

  // Runs git, resolving with its exit code and output when it exits.
  function runGit(args, cwd) {
    return new Promise(function (resolve, reject) {
      var child = spawn("git", args, {
        cwd: cwd,
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" }),
      });
      var output = "";
      var timeout = setTimeout(function () {
        child.kill("SIGKILL");
        reject(new Error("git " + args[0] + " did not exit: " + output));
      }, 45 * 1000);

      child.stdout.on("data", function (chunk) {
        output += chunk;
      });
      child.stderr.on("data", function (chunk) {
        output += chunk;
      });
      child.on("error", function (err) {
        clearTimeout(timeout);
        reject(err);
      });
      child.on("close", function (code) {
        clearTimeout(timeout);
        resolve({ code: code, output: output });
      });
    });
  }

  // Commits a few tens of MB of random data to the user's local repo.
  async function commitBigFiles(ctx) {
    for (var i = 0; i < BIG_FILES; i++) {
      await fs.outputFile(
        ctx.repoDirectory + "/big-" + i + ".bin",
        crypto.randomBytes(BIG_FILE_BYTES)
      );
    }

    await ctx.git.add(".");
    await ctx.git.commit("add big files");
  }

  // Sends a request with a Content-Length longer than the body we actually
  // write, then drops the connection while the server is waiting for the rest.
  function sendAbortedPost(ctx, service, body) {
    var parsed = new url.URL(ctx.repoUrl);
    var auth =
      decodeURIComponent(parsed.username) +
      ":" +
      decodeURIComponent(parsed.password);

    return new Promise(function (resolve) {
      var req = http.request({
        method: "POST",
        hostname: "127.0.0.1",
        port: ctx.server.port,
        path:
          "/clients/git/end/" + ctx.blog.handle + ".git/git-" + service,
        headers: {
          Authorization: "Basic " + Buffer.from(auth).toString("base64"),
          "Content-Type": "application/x-git-" + service + "-request",
          "Content-Length": 10 * 1024 * 1024,
        },
      });

      req.on("error", function () {});
      req.on("response", function (res) {
        res.resume();
      });
      req.on("close", resolve);
      req.write(body);

      // Give the server time to authenticate and start reading the body.
      setTimeout(function () {
        req.destroy();
      }, SETTLE_MS);
    });
  }

  function pktLine(content) {
    return ("0000" + (content.length + 4).toString(16)).slice(-4) + content;
  }

  var ZERO = new Array(41).join("0");
  var SHA = new Array(41).join("a");


  // The git processes the server runs for a request are the service itself
  // (git-receive-pack or git-upload-pack, which has the repository path in its
  // arguments) and the helpers that service starts. index-pack and
  // pack-objects have no repository path in their arguments but, like the
  // service, run with the bare repository as their working directory, so that
  // is how we recognise them.
  var GIT_SERVICE_PROCESS = /(^|[\s/])git[ -](receive-pack|upload-pack|index-pack|unpack-objects|pack-objects)(\s|$)/;

  function run(command, args) {
    return new Promise(function (resolve) {
      childProcess.execFile(command, args, function (err, stdout) {
        resolve(err ? "" : String(stdout));
      });
    });
  }

  async function workingDirectory(pid) {
    try {
      return await fs.realpath("/proc/" + pid + "/cwd");
    } catch (err) {
      // No /proc (macOS)
    }

    var output = await run("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"]);
    var line = output.split("\n").find(function (line) {
      return line[0] === "n";
    });

    if (!line) return null;

    try {
      return await fs.realpath(line.slice(1));
    } catch (err) {
      return null;
    }
  }

  // Lists the git service processes (and their index-pack and pack-objects
  // helpers) running against the given bare repository, as "pid args" strings.
  async function gitProcessesFor(repoPath) {
    var realRepoPath = await fs.realpath(repoPath).catch(function () {
      return repoPath;
    });
    var listing = await run("ps", ["-eo", "pid=,ppid=,args="]);
    var found = [];

    for (var line of listing.split("\n")) {
      var match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);

      if (!match || Number(match[1]) === process.pid) continue;
      if (!GIT_SERVICE_PROCESS.test(match[3])) continue;

      if (
        match[3].indexOf(repoPath) !== -1 ||
        match[3].indexOf(realRepoPath) !== -1 ||
        (await workingDirectory(match[1])) === realRepoPath
      ) {
        found.push(match[1] + " " + match[3]);
      }
    }

    return found;
  }

  // Directories git creates to hold a push until it has been checked
  // (objects/tmp_objdir-incoming-*). It deletes them when the push fails, but
  // not if the process is killed first.
  async function quarantinesIn(repoPath) {
    var entries = await fs.readdir(repoPath + "/objects").catch(function () {
      return [];
    });

    return entries.filter(function (name) {
      return name.indexOf("tmp_objdir-incoming-") === 0;
    });
  }

  // An aborted request must not leave git running (a stuck git-receive-pack
  // and the git index-pack it started hold hundreds of MB between them) or its
  // quarantine directory on disk, so wait for git to finish cleaning up.
  async function expectGitToCleanUp(ctx) {
    var repoPath = dataDir + "/" + ctx.blog.handle + ".git";
    var deadline = Date.now() + CLEANUP_MS;
    var processes, quarantines;

    do {
      processes = await gitProcessesFor(repoPath);
      quarantines = await quarantinesIn(repoPath);

      if (!processes.length && !quarantines.length) break;

      await sleep(250);
    } while (Date.now() < deadline);

    expect(processes).toEqual([]);
    expect(quarantines).toEqual([]);
  }

  // The server must not have thrown, must have cleaned up after the aborted
  // request, and must still answer a new git client.
  async function expectServerStillWorks(ctx) {
    await sleep(SETTLE_MS);

    expect(ctx.uncaught.map(String)).toEqual([]);

    await expectGitToCleanUp(ctx);
    expect(ctx.server.listening).toBe(true);

    var result = await runGit(["ls-remote", ctx.repoUrl], ctx.tmp);

    expect(result.output).not.toMatch(/fatal|error/i);
    expect(result.code).toBe(0);
  }

  it("survives a large branch push aborted part way through", async function () {
    var ctx = this;
    var proxy = await startProxy(ctx, { fromClient: 4 * 1024 * 1024 });

    await commitBigFiles(ctx);

    var result = await runGit(
      ["push", proxy.repoUrl, "HEAD:refs/heads/master"],
      ctx.repoDirectory
    );

    expect(proxy.aborted).toBe(true);
    expect(result.code).not.toBe(0);

    await expectServerStillWorks(ctx);
  });

  it("survives a large tag-only push aborted part way through", async function () {
    var ctx = this;
    var proxy = await startProxy(ctx, { fromClient: 4 * 1024 * 1024 });

    await commitBigFiles(ctx);
    await ctx.git.addTag("v1");

    var result = await runGit(
      ["push", proxy.repoUrl, "refs/tags/v1"],
      ctx.repoDirectory
    );

    expect(proxy.aborted).toBe(true);
    expect(result.code).not.toBe(0);

    await expectServerStillWorks(ctx);
  });

  it("survives a push aborted before its commands could be read", async function () {
    var ctx = this;

    // pushover only identifies the push from the first chunk of the body, so
    // a body that doesn't look like one never reaches a 'push' listener.
    await sendAbortedPost(ctx, "receive-pack", "not a git command");
    await expectServerStillWorks(ctx);
  });

  it("survives an aborted tag push request", async function () {
    var ctx = this;
    var command = ZERO + " " + SHA + " refs/tags/v1\u0000 report-status\n";

    await sendAbortedPost(ctx, "receive-pack", pktLine(command));
    await expectServerStillWorks(ctx);
  });

  it("survives an aborted fetch request", async function () {
    var ctx = this;

    await sendAbortedPost(
      ctx,
      "upload-pack",
      pktLine("want " + SHA + "\n")
    );
    await expectServerStillWorks(ctx);
  });

  it("survives a clone aborted part way through the download", async function () {
    var ctx = this;
    var proxy = await startProxy(ctx, { fromServer: 2 * 1024 * 1024 });

    await commitBigFiles(ctx);

    // Put the data straight into the bare repo so the server has something
    // large to send, without waiting for Blot to sync it as a real push would.
    await ctx.git.push(
      dataDir + "/" + ctx.blog.handle + ".git",
      "HEAD:refs/heads/master"
    );

    var result = await runGit(
      ["clone", proxy.repoUrl, ctx.tmp + "/aborted-clone"],
      ctx.tmp
    );

    expect(proxy.aborted).toBe(true);
    expect(result.code).not.toBe(0);

    await expectServerStillWorks(ctx);
  });
});
