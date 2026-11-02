// Serves the receive side of git's smart HTTP protocol: the ref advertisement
// for a push and the POST that carries it. Git's own receive-pack would write
// the refs and the report itself, leaving no place to run Blot's checks before
// the client is told "ok", so this does what it does, in Node:
//
//   1. read the commands (<old> <new> <ref>) up to the flush packet
//   2. stream the pack into `git index-pack --fix-thin` in a quarantine
//      directory inside the repository (objects/tmp_objdir-incoming-XXXXXX,
//      which sweepQuarantine.js recognises), with the repository as an
//      alternate, as git's own tmp_objdir does. Nothing reaches the
//      repository yet, and no lock is held however long this takes.
//   3. check the push: the refs are allowed, the objects are all there and
//      connected to what the repository has, and master's tree is one Blot
//      can sync
//   4. under a short lock: check no ref has moved, move the objects out of
//      quarantine, write the follow-up sync (prepare), and update all the refs
//      in one transaction
//   5. tell the client, then start the sync (accepted)
//
// A push is applied whole or not at all: if any ref is refused or stale, none
// is updated. Everything is a hook, so a store which keeps its repositories
// somewhere else can reuse the parsing, the checks and the report.
//
//   receivePack.handle(req, res, {
//     directory,            the bare repository
//     handle,               for logs
//     lock(),               resolves to a function which releases a short
//                           lock on the refs; optional
//     prepare(master),      before the refs move, under the lock, with the
//                           update to master ({ old, new }) if the push has
//                           one; its result is passed on. A rejection fails
//                           the push without moving anything.
//     accepted(master, p),  after the refs have moved
//     abandoned(master, p), after prepare, if the refs did not move
//   })
var fs = require("fs-extra");
var path = require("path");
var zlib = require("zlib");
var spawn = require("child_process").spawn;
var debug = require("debug")("blot:clients:git:receivePack");
var clfdate = require("helper/clfdate");
var guardServices = require("./guardServices");
var Git = require("./git");
var limiter = require("./limiter");
var gc = require("./gc");
var validateTree = require("./validateTree");
var QUARANTINE_PREFIX = require("./sweepQuarantine").PREFIX;

var ZERO = new Array(41).join("0");

// What this implements, and so all it advertises. The pack is read by
// index-pack, which accepts ofs-delta; "agent" is only logged.
var CAPABILITIES = [
  "report-status",
  "delete-refs",
  "side-band-64k",
  "quiet",
  "ofs-delta",
  "agent=blot",
];

// The command section of a push is a few hundred bytes. A client which sends
// more than this before the flush packet is not git.
var MAX_COMMAND_BYTES = 1024 * 1024;
var MAX_COMMANDS = 5000;

// The longest pkt-line git allows, and so the most a side-band packet holds
var MAX_PACKET = 65520;

// How long update-ref and the other commands under the lock get, and how long
// the commands which read a whole pack (the request itself ends in an hour)
var GIT_TIMEOUT_MS = 30 * 1000;
var LONG_TIMEOUT_MS = 60 * 60 * 1000;

var MASTER = "refs/heads/master";

function noop() {}

function noCache(res) {
  res.setHeader("expires", "Fri, 01 Jan 1980 00:00:00 GMT");
  res.setHeader("pragma", "no-cache");
  res.setHeader("cache-control", "no-cache, max-age=0, must-revalidate");
}

function pktLine(content) {
  var body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  var length = (4 + body.length).toString(16);

  return Buffer.concat([Buffer.from("0000".slice(length.length) + length), body]);
}

function badRequest(message) {
  var err = new Error(message);

  err.badRequest = true;

  return err;
}

// One line of text for a report or a log: no newlines, a sensible length
function oneLine(text) {
  return String(text).replace(/[\r\n\0]+/g, " ").trim().slice(0, 1000);
}

// Git's rules for ref names (git-check-ref-format), for the names a push may
// create. Anything git itself would refuse is refused by update-ref later.
function refNameProblem(ref) {
  if (ref.indexOf("refs/") !== 0) return "ref names must start with refs/";
  if (Buffer.byteLength(ref) > 1024) return "ref name is too long";
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return "ref name has a character git does not allow";
  if (/\.\.|@\{|\/\/|\/$|\.$|^@$/.test(ref)) return "ref name is not valid";
  if (/(^|\/)\./.test(ref) || /\.lock(\/|$)/.test(ref)) return "ref name is not valid";

  return null;
}

// Why a command is not allowed, or null. Blot syncs master, and tags are kept
// but do nothing; there are no other branches, or other kinds of ref.
function refusal(command) {
  var problem = refNameProblem(command.ref);

  if (problem) return "Push rejected: " + problem + ".";

  if (command.ref === MASTER) {
    if (command.new === ZERO) return "Push rejected: master cannot be deleted.";
    return null;
  }

  if (command.ref.indexOf("refs/heads/") === 0) {
    return "Push rejected: only the master branch is allowed. Please push to master or open a PR.";
  }

  if (command.ref.indexOf("refs/tags/") === 0) return null;

  return "Push rejected: only master and tags can be pushed.";
}

// Reads pkt-lines from an async iterator of Buffers up to and including the
// first flush packet. Resolves with the lines and whatever followed the flush
// packet in the last chunk read; the iterator is left to continue from there.
async function readPackets(iterator) {
  var buffer = Buffer.alloc(0);
  var lines = [];
  var size = 0;

  for (;;) {
    while (buffer.length >= 4) {
      var header = buffer.toString("latin1", 0, 4);

      if (!/^[0-9a-fA-F]{4}$/.test(header)) throw badRequest("not a git request");

      var length = parseInt(header, 16);

      if (length === 0) return { lines: lines, rest: buffer.subarray(4) };
      if (length < 4 || length > MAX_PACKET) throw badRequest("invalid packet length");
      if (buffer.length < length) break;

      lines.push(buffer.subarray(4, length));
      size += length;
      buffer = buffer.subarray(length);

      if (size > MAX_COMMAND_BYTES || lines.length > MAX_COMMANDS) {
        throw badRequest("too many commands");
      }
    }

    var next = await iterator.next();

    if (next.done) throw badRequest("the request ended before its commands did");

    buffer = Buffer.concat([buffer, next.value]);
  }
}

// { commands: [{ old, new, ref }], capabilities: ["report-status", ...] }
function parseCommands(lines) {
  var commands = [];
  var capabilities = [];

  lines.forEach(function (line) {
    var text = line.toString("utf8");
    var nul = text.indexOf("\0");

    if (nul !== -1) {
      if (!capabilities.length) {
        capabilities = text
          .slice(nul + 1)
          .replace(/\n$/, "")
          .split(" ")
          .filter(Boolean);
      }
      text = text.slice(0, nul);
    }

    text = text.replace(/\n$/, "");

    // Sent by a client with a shallow clone: what it lacks is checked below,
    // by looking for what the pushed commits need
    if (/^shallow [0-9a-f]{40}$/.test(text)) return;

    var match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text);

    if (!match) throw badRequest("malformed command");

    commands.push({ old: match[1], new: match[2], ref: match[3] });
  });

  return { commands: commands, capabilities: capabilities };
}

function capability(capabilities, name) {
  for (var i = 0; i < capabilities.length; i++) {
    if (capabilities[i] === name) return true;
    if (capabilities[i].indexOf(name + "=") === 0) return capabilities[i].slice(name.length + 1);
  }

  return false;
}

// What the client reads once the push is over. status is "ok" or why the pack
// could not be unpacked; results are { ref, error } with no error when the
// ref was updated; messages are for the user, shown as "remote: ..." lines.
// Without report-status the client wants no report, and without side-band-64k
// no messages.
function formatResponse(capabilities, status, results, messages) {
  var parts = [];
  var sideband = capability(capabilities, "side-band-64k");

  function band(number, content) {
    for (var i = 0; i < content.length || i === 0; i += MAX_PACKET - 5) {
      parts.push(pktLine(Buffer.concat([Buffer.from([number]), content.subarray(i, i + MAX_PACKET - 5)])));
    }
  }

  if (sideband) {
    messages.forEach(function (message) {
      band(2, Buffer.from(oneLine(message) + "\n"));
    });
  }

  if (capability(capabilities, "report-status")) {
    var report = [pktLine("unpack " + oneLine(status) + "\n")];

    results.forEach(function (result) {
      report.push(
        pktLine(result.error ? "ng " + result.ref + " " + oneLine(result.error) + "\n" : "ok " + result.ref + "\n")
      );
    });

    report.push(Buffer.from("0000"));
    report = Buffer.concat(report);

    if (sideband) {
      band(1, report);
    } else {
      parts.push(report);
    }
  }

  if (sideband) parts.push(Buffer.from("0000"));

  return Buffer.concat(parts);
}

// The sizes git reads from config are written like 1900m
function parseSize(value) {
  var match = /^(\d+)([kmg]?)$/i.exec(String(value).trim());

  if (!match) return 0;

  return Number(match[1]) * Math.pow(1024, " kmg".indexOf((match[2] || " ").toLowerCase()));
}

function isTrue(value) {
  return /^(true|yes|on|1)$/i.test(String(value).trim());
}

// Runs a short git command in the repository and collects its output. A push
// is interactive work (see limiter.js).
function runGit(context, args, options) {
  return limiter.run("interactive", function () {
    return spawnGit(context, args, options);
  });
}

function spawnGit(context, args, options) {
  options = options || {};

  return new Promise(function (resolve, reject) {
    var child = spawn("git", limiter.args(args), {
      cwd: context.directory,
      env: options.env || context.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    var stdout = [];
    var stderr = guardServices.createTail(guardServices.STDERR_TAIL_BYTES);
    var timer = setTimeout(function () {
      child.kill("SIGKILL");
    }, options.timeout || LONG_TIMEOUT_MS);

    context.children.add(child);

    child.stdout.on("data", function (chunk) {
      stdout.push(chunk);
    });
    child.stderr.on("data", function (chunk) {
      stderr.add(chunk);
    });
    child.stdin.on("error", noop);
    child.on("error", function (err) {
      clearTimeout(timer);
      context.children.delete(child);
      reject(err);
    });
    child.on("close", function (code) {
      clearTimeout(timer);
      context.children.delete(child);
      resolve({ code: code, stdout: Buffer.concat(stdout).toString(), stderr: stderr.toString() });
    });

    child.stdin.end(options.input || "");
  });
}

// receive.maxInputSize (set for every git process in the container by the
// Dockerfile) and whether to check objects as git's receive-pack does
async function readLimits(context) {
  var result = await runGit(context, [
    "config",
    "--get-regexp",
    "^(receive|transfer)\\.(maxinputsize|fsckobjects)$",
  ]);
  var values = {};

  result.stdout.split("\n").forEach(function (line) {
    var space = line.indexOf(" ");

    if (space > 0) values[line.slice(0, space)] = line.slice(space + 1);
  });

  var fsck = "receive.fsckobjects" in values ? values["receive.fsckobjects"] : values["transfer.fsckobjects"];

  return {
    maxInputSize: parseSize(values["receive.maxinputsize"] || 0),
    strict: fsck !== undefined && isTrue(fsck),
  };
}

function quarantineEnv(context) {
  return Object.assign({}, context.env, {
    GIT_OBJECT_DIRECTORY: context.quarantine,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(context.directory, "objects"),
  });
}

// Reads and drops the rest of the request, so that the client can still read
// the answer
async function drain(iterator, chunk) {
  while (chunk) {
    var next = await iterator.next();

    chunk = next.done ? null : next.value;
  }
}

function writeChunk(stream, chunk) {
  if (stream.destroyed || !stream.writable) return Promise.resolve(false);

  return new Promise(function (resolve) {
    if (stream.write(chunk)) return resolve(true);

    function done() {
      stream.removeListener("drain", done);
      stream.removeListener("close", done);
      stream.removeListener("error", done);
      resolve(!stream.destroyed);
    }

    stream.once("drain", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

// A line to show the user from what git wrote to stderr
function describeGitError(stderr, limits) {
  if (/maximum allowed size/.test(stderr)) {
    var megabytes = Math.round(limits.maxInputSize / (1024 * 1024));

    return "the push is larger than the " + megabytes + " MB Blot accepts";
  }

  var lines = stderr.split("\n").map(function (line) {
    return line.replace(/^(fatal|error): /, "").trim();
  }).filter(Boolean);

  return lines.length ? lines[lines.length - 1] : "git could not read the pack";
}

// Streams what is left of the request into index-pack, in a new quarantine
// directory. Resolves { ok: true } or { error } (and always reads the whole
// request, so that the client can read the answer). Rejects only if the
// request itself fails.
async function unpack(context, first, iterator, limits) {
  var started = null;
  var written = 0;
  var chunk = first;

  // index-pack holds its place in the interactive lane until it has closed
  async function start() {
    var args = ["index-pack", "--stdin", "--fix-thin"];

    if (limits.strict) args.push("--strict");
    if (limits.maxInputSize) args.push("--max-input-size=" + limits.maxInputSize);

    var release = await limiter.acquire("interactive");
    var child = spawn("git", limiter.args(args), {
      cwd: context.directory,
      env: quarantineEnv(context),
      stdio: ["pipe", "ignore", "pipe"],
    });
    var stderr = guardServices.createTail(guardServices.STDERR_TAIL_BYTES);
    var closed = new Promise(function (resolve) {
      child.on("error", function (err) {
        stderr.add(err.message);
        // Not started, so there is no close
        if (child.pid === undefined) release();
        resolve({ code: 127 });
      });
      child.on("close", function (code) {
        release();
        context.children.delete(child);
        resolve({ code: code });
      });
    });

    context.children.add(child);
    child.stdin.on("error", noop);
    child.stderr.on("data", function (data) {
      stderr.add(data);
    });

    started = { child: child, stderr: stderr, closed: closed };
    context.indexPack = started;
  }

  while (chunk) {
    if (chunk.length) {
      if (!started) {
        // Under the same prefix git uses, which sweepQuarantine.js looks for
        context.quarantine = await fs.mkdtemp(
          path.join(context.directory, "objects", QUARANTINE_PREFIX)
        );
        await fs.ensureDir(path.join(context.quarantine, "pack"));
        await start();
      }

      written += chunk.length;

      // False once index-pack has stopped reading: it says why when it exits
      if (!(await writeChunk(started.child.stdin, chunk))) break;
    }

    var next = await iterator.next();

    chunk = next.done ? null : next.value;
  }

  await drain(iterator, chunk);

  if (!started) return { error: "eof before pack header was fully read" };

  if (started.child.stdin.writable) started.child.stdin.end();

  var exit = await started.closed;

  context.rx = written;

  if (exit.code !== 0) {
    context.exit = exit.code || 1;
    context.stderr = started.stderr.toString();
    return { error: describeGitError(context.stderr, limits) };
  }

  return { ok: true };
}

// The type of each object (null if it is missing), looking in quarantine as
// well as in the repository
async function objectTypes(context, shas) {
  var result = await runGit(context, ["cat-file", "--batch-check"], {
    env: quarantineEnv(context),
    input: shas.join("\n") + "\n",
  });
  var types = {};

  result.stdout.split("\n").forEach(function (line) {
    var parts = line.split(" ");

    if (parts[0]) types[parts[0]] = parts[1] === "missing" ? null : parts[1];
  });

  return types;
}

// Checks the pushed objects before anything is updated. Returns a reason for
// each ref which cannot be updated: { ref: reason }.
async function check(context, commands) {
  var problems = {};
  var updates = commands.filter(function (command) {
    return command.new !== ZERO;
  });

  if (!updates.length) return problems;

  var shas = updates.map(function (command) {
    return command.new;
  });
  var types = await objectTypes(context, shas);

  updates.forEach(function (command) {
    if (!types[command.new]) {
      problems[command.ref] = "missing necessary objects";
    } else if (command.ref.indexOf("refs/heads/") === 0 && types[command.new] !== "commit") {
      problems[command.ref] = "branches must point to a commit";
    }
  });

  if (Object.keys(problems).length) return problems;

  // Everything the new tips need is in the pack or the repository
  var connected = await runGit(
    context,
    ["rev-list", "--objects", "--stdin", "--not", "--all", "--quiet"],
    { env: quarantineEnv(context), input: shas.join("\n") + "\n" }
  );

  if (connected.code !== 0) {
    debug("Connectivity check failed", connected.stderr);

    updates.forEach(function (command) {
      problems[command.ref] = "missing necessary objects";
    });

    return problems;
  }

  // What Blot can sync: regular files only
  for (var i = 0; i < updates.length; i++) {
    if (updates[i].ref !== MASTER) continue;

    try {
      await validateTree(
        Git(context.directory, { env: quarantineEnv(context), lane: "interactive" }),
        updates[i].new
      );
    } catch (err) {
      problems[MASTER] = oneLine(err.message);
    }
  }

  return problems;
}

async function currentRefs(context) {
  var result = await runGit(context, ["for-each-ref", "--format=%(objectname) %(refname)"], {
    timeout: GIT_TIMEOUT_MS,
  });
  var refs = {};

  if (result.code !== 0) throw new Error("could not read refs: " + result.stderr);

  result.stdout.split("\n").forEach(function (line) {
    if (line) refs[line.slice(41)] = line.slice(0, 40);
  });

  return refs;
}

// Moves the pack out of quarantine into the repository. A pack is found
// through its .idx, so that goes last: git never sees half a pack.
async function migrate(context) {
  var source = path.join(context.quarantine, "pack");
  var target = path.join(context.directory, "objects", "pack");
  var names = await fs.readdir(source);
  var bases = {};
  var moved = [];

  names.forEach(function (name) {
    var match = /^(pack-[0-9a-f]+)\.[a-z]+$/.exec(name);

    if (match) bases[match[1]] = true;
  });

  await fs.ensureDir(target);

  try {
    for (var base of Object.keys(bases)) {
      // The same pack is already there
      if (await fs.pathExists(path.join(target, base + ".idx"))) continue;

      var files = names
        .filter(function (name) {
          return name.indexOf(base + ".") === 0 && name !== base + ".idx";
        })
        .concat(base + ".idx");

      for (var file of files) {
        await fs.rename(path.join(source, file), path.join(target, file));
        moved.push(path.join(target, file));
      }
    }
  } catch (err) {
    await Promise.all(moved.map(function (file) {
      return fs.remove(file);
    }));
    throw err;
  }
}

async function updateRefs(context, commands) {
  var input = commands
    .map(function (command) {
      if (command.new === ZERO) return "delete " + command.ref + " " + command.old + "\n";
      if (command.old === ZERO) return "create " + command.ref + " " + command.new + "\n";
      return "update " + command.ref + " " + command.new + " " + command.old + "\n";
    })
    .join("");

  // One transaction: all the refs move or none does
  var result = await runGit(context, ["update-ref", "--stdin"], {
    input: input,
    timeout: GIT_TIMEOUT_MS,
  });

  if (result.code !== 0) {
    debug("update-ref failed", result.stderr);
    return oneLine(result.stderr.replace(/^(fatal|error): /gm, "")) || "failed to update ref";
  }

  return null;
}

function lockProblem(err) {
  if (err && err.code === "ELOCKED") {
    return "another change to this repository is being applied; please try again in a few seconds";
  }

  return "Blot could not accept the push right now; please try again in a moment";
}

// The part of a push which needs the repository to stand still: from checking
// that no ref has moved to updating them. Resolves with an error for the
// whole push, or null once the refs have been updated.
async function apply(context, commands, options) {
  var release = options.lock ? await options.lock() : noop;
  var prepared;
  var master = null;
  var readied = false;

  try {
    var current = await currentRefs(context);
    var stale = commands.filter(function (command) {
      return (current[command.ref] || ZERO) !== command.old;
    });

    if (stale.length) {
      return {
        refs: stale.map(function (command) {
          return command.ref;
        }),
        error: "the ref moved while you were pushing; pull and try again",
      };
    }

    commands.forEach(function (command) {
      if (command.ref === MASTER && command.old !== command.new) master = command;
    });

    if (context.quarantine) await migrate(context);

    // Written before the refs move, so a push which has been acknowledged is
    // never lost, and a push which could not be recorded never happens
    if (master && options.prepare) {
      try {
        prepared = await limiter.outside(function () {
          return options.prepare(master);
        });
      } catch (err) {
        console.error(clfdate(), "Git: could not record push", context.handle, err);
        return { error: "Blot could not record the push; please try again in a moment" };
      }

      readied = true;
    }

    var failure = await updateRefs(context, commands);

    if (failure) {
      if (readied && options.abandoned) {
        await Promise.resolve(
          limiter.outside(function () {
            return options.abandoned(master, prepared);
          })
        ).catch(noop);
      }
      return { error: failure };
    }

    if (master && options.accepted) {
      try {
        // The sync this starts waits for room of its own
        limiter.outside(function () {
          options.accepted(master, prepared);
        });
      } catch (err) {
        console.error(clfdate(), "Git: error after push", context.handle, err);
      }
    }

    return null;
  } finally {
    await Promise.resolve(release()).catch(function (err) {
      console.error(clfdate(), "Git: could not release the ref lock", context.handle, err);
    });
  }
}

function exitLine(req, context, started, tx) {
  console.log(
    guardServices.formatExitLine({
      requestId: req.headers && req.headers["x-request-id"],
      service: "receive-pack",
      handle: context.handle,
      code: context.exit,
      durationMs: Date.now() - started,
      rx: context.rx,
      tx: tx,
      stderr: context.stderr,
    })
  );
}

// Runs a push. Always reads the whole request before answering.
async function receive(req, res, options) {
  var started = Date.now();
  var directory = path.resolve(options.directory);
  var env = Object.assign({}, process.env, { GIT_DIR: directory });
  var context = {
    directory: directory,
    handle: options.handle,
    env: env,
    children: new Set(),
    quarantine: null,
    indexPack: null,
    exit: 0,
    rx: 0,
    stderr: "",
  };
  var tx = 0;
  var gunzip = null;
  var source = req;
  var parsed = null;

  delete env.GIT_PROTOCOL;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;

  res.setHeader("connection", "close");
  res.setHeader("content-type", "application/x-git-receive-pack-result");
  noCache(res);

  if (req.headers["content-encoding"] === "gzip") {
    gunzip = source = zlib.createGunzip();
    req.pipe(gunzip);
  }

  // A client which goes away part way through ends the stream with an error.
  // Piping does not pass it on.
  req.on("error", function (err) {
    if (gunzip) gunzip.destroy(err);
  });
  req.on("aborted", function () {
    if (gunzip) gunzip.destroy(new Error("aborted"));
  });

  // Ends what is still running, deletes the quarantine and logs the exit line,
  // once. The client is told only after this, so it never hears of a push
  // which has left anything behind.
  var finished = null;

  function finish() {
    if (!finished) {
      finished = cleanUp(context).then(function () {
        exitLine(req, context, started, tx);
      });
    }

    return finished;
  }

  async function send(buffer) {
    tx = buffer.length;

    await finish();

    if (res.destroyed || res.writableEnded) return;

    res.end(buffer);
  }

  try {
    var iterator = source[Symbol.asyncIterator]();
    var packets = await readPackets(iterator);

    parsed = parseCommands(packets.lines);

    // Git's 0000 probe, sent before a request larger than http.postBuffer
    if (!parsed.commands.length) return await send(Buffer.alloc(0));

    var commands = parsed.commands;
    var capabilities = parsed.capabilities;
    var agent = capability(capabilities, "agent");

    console.log(
      clfdate(),
      (req.headers["x-request-id"] || "no-request-id"),
      "Git: push-client",
      options.handle,
      "agent=" + JSON.stringify(typeof agent === "string" ? agent.slice(0, 100) : "")
    );

    var problems = {};
    var seen = {};
    var status = "ok";

    commands.forEach(function (command) {
      var reason = seen[command.ref] ? "ref given twice in one push" : refusal(command);

      seen[command.ref] = true;

      if (reason) problems[command.ref] = reason;
    });

    var needsPack = commands.some(function (command) {
      return command.new !== ZERO;
    });

    // Nothing to unpack for a refused push or a deletion; the pack is
    // still read, or the client would see its connection reset
    if (needsPack && !Object.keys(problems).length) {
      var limits = options.limits || (await readLimits(context));
      var unpacked = await unpack(context, packets.rest, iterator, limits);

      if (unpacked.error) {
        status = unpacked.error;
      } else {
        problems = await check(context, commands);
      }
    } else {
      await drain(iterator, packets.rest);
    }

    if (status === "ok" && !Object.keys(problems).length) {
      try {
        // One place in the interactive lane, taken before the ref lock, for
        // the commands run under it: none of them waits for room with the
        // lock held
        var applied = await limiter.run("interactive", function () {
          return apply(context, commands, options);
        });

        if (applied) {
          (applied.refs || commands.map(function (command) {
            return command.ref;
          })).forEach(function (ref) {
            problems[ref] = applied.error;
          });
        }
      } catch (err) {
        console.error(clfdate(), "Git: error applying push", options.handle, err);
        commands.forEach(function (command) {
          problems[command.ref] = lockProblem(err);
        });
      }
    }

    var refused = Object.keys(problems).length > 0 || status !== "ok";
    var messages = [];

    if (refused) {
      context.stderr = context.stderr || oneLine(status !== "ok" ? status : JSON.stringify(problems));
      messages = status !== "ok"
        ? ["Push failed: " + status]
        : Object.keys(problems).map(function (ref) {
            return ref + ": " + problems[ref];
          });
      messages.push("Nothing was pushed.");
    }

    await send(
      formatResponse(
        capabilities,
        status,
        commands.map(function (command) {
          if (status !== "ok") return { ref: command.ref, error: "unpacker error" };
          if (problems[command.ref]) return { ref: command.ref, error: problems[command.ref] };
          if (refused) return { ref: command.ref, error: "not updated because the rest of the push was refused" };
          return { ref: command.ref };
        }),
        messages
      )
    );

    if (!refused && options.autogc !== false) collect(context);
  } catch (err) {
    context.exit = 1;
    context.stderr = oneLine(err.message);

    if (err.badRequest || (gunzip && err.code && /^Z_/.test(err.code))) {
      debug("Bad receive-pack request", err.message);

      if (!res.headersSent) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain");
      }

      await send(Buffer.from("bad request body"));
    } else if (parsed && parsed.commands.length && !res.destroyed && req.complete) {
      console.error(clfdate(), "Git: error receiving push", options.handle, err);
      await send(
        formatResponse(
          parsed.capabilities,
          "internal error",
          parsed.commands.map(function (command) {
            return { ref: command.ref, error: "internal error" };
          }),
          ["Blot hit an error receiving the push; please try again in a moment."]
        )
      );
    } else {
      // The client has gone
      debug("Receive aborted", err.message);
      if (!res.writableEnded) res.destroy();
    }
  } finally {
    await finish();
  }
}

// Ends anything still running for a push and deletes its quarantine directory
async function cleanUp(context) {
  var running = [];

  context.children.forEach(function (child) {
    running.push(
      new Promise(function (resolve) {
        child.once("close", resolve);
      })
    );
    child.kill("SIGKILL");
  });

  await Promise.all(running);

  if (context.quarantine) {
    await fs.remove(context.quarantine).catch(function (err) {
      console.error(clfdate(), "Git: could not remove quarantine", context.quarantine, err);
    });
  }
}

// What git's receive-pack does after a push: keep the repository from
// filling up with packs. A burst of pushes and commits makes one gc (gc.js).
function collect(context) {
  gc.schedule(context.directory);
}

// GET /<handle>.git/info/refs?service=git-receive-pack: the refs, sorted as
// git sorts them, and what we implement. Receive-pack advertises no HEAD.
async function advertise(req, res, directory) {
  res.setHeader("connection", "close");

  try {
    var git = Git(directory, { lane: "interactive" });
    var output = await git.raw(["for-each-ref", "--format=%(objectname) %(refname)"]);
  } catch (err) {
    if (!fs.pathExistsSync(directory)) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      return res.end("repository not found");
    }

    debug("Error listing refs", err);
    res.statusCode = 500;
    return res.end();
  }

  var capabilities = CAPABILITIES.join(" ");
  var refs = output.split("\n").filter(Boolean);
  var parts = [pktLine("# service=git-receive-pack\n"), Buffer.from("0000")];

  if (!refs.length) {
    parts.push(pktLine(ZERO + " capabilities^{}\0" + capabilities + "\n"));
  } else {
    refs.forEach(function (ref, index) {
      parts.push(pktLine(ref + (index === 0 ? "\0" + capabilities : "") + "\n"));
    });
  }

  parts.push(Buffer.from("0000"));

  res.setHeader("content-type", "application/x-git-receive-pack-advertisement");
  noCache(res);
  res.end(Buffer.concat(parts));
}

// Nothing waits for a push, so nothing it throws may go unhandled
function handle(req, res, options) {
  return receive(req, res, options).catch(function (err) {
    console.error(clfdate(), "Git: receive-pack failed", options.handle, err);
    res.destroy();
  });
}

module.exports = {
  handle: handle,
  advertise: advertise,
  // For anything else which receives pushes
  readPackets: readPackets,
  parseCommands: parseCommands,
  refusal: refusal,
  formatResponse: formatResponse,
  CAPABILITIES: CAPABILITIES,
  noCache: noCache,
  pktLine: pktLine,
};
