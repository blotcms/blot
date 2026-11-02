// Puts a `git` first on PATH which writes a line to a log when it starts and
// when the real git it runs has exited, with its pid, GIT_DIR, working
// directory and arguments, so a spec can see what the git client ran, with
// which settings, and how many ran at once. Everything that finds git on PATH
// goes through it while it is installed: spawn and execFile look git up on
// the PATH of the environment they are given.
//
//   var spy = spyGit();
//   beforeEach(spy.install);           // or spy.install() in a spec
//   afterEach(spy.restore);
//   spy.commands(filter)               // [{ pid, gitDir, cwd, args }]
//   spy.mostAtOnce(filter)             // how many ran at once, at most
//
// filter(command) picks the commands to look at. Set GIT_SPY_SLEEP in
// process.env to make each command take that many seconds longer.
//
// The log and the real git are written into the script too, so the git store's
// commands (store/), which run without the GIT_ variables of their caller's
// environment, are logged and run as well.
var fs = require("fs-extra");
var path = require("path");
var childProcess = require("child_process");
var tempDir = require("helper/tempDir");

var SCRIPT = [
  "#!/bin/sh",
  'printf "start\\t%s\\t%s\\t%s\\t%s\\n" "$$" "$GIT_DIR" "$PWD" "$*" >> "$GIT_SPY_LOG"',
  'if [ -n "$GIT_SPY_SLEEP" ]; then sleep "$GIT_SPY_SLEEP"; fi',
  '"$GIT_SPY_REAL" "$@"',
  "code=$?",
  'printf "end\\t%s\\n" "$$" >> "$GIT_SPY_LOG"',
  "exit $code",
  "",
].join("\n");

// A shell word for a path
function quote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

module.exports = function spyGit() {
  var spy = {};
  var saved = null;

  spy.install = function () {
    var directory = fs.mkdtempSync(path.join(tempDir(), "git-spy-"));
    var real = childProcess.execFileSync("sh", ["-c", "command -v git"]).toString().trim();

    spy.log = path.join(directory, "log");

    fs.writeFileSync(
      path.join(directory, "git"),
      SCRIPT.split('"$GIT_SPY_LOG"').join(quote(spy.log)).split('"$GIT_SPY_REAL"').join(quote(real)),
      { mode: 0o755 }
    );

    saved = {
      directory: directory,
      PATH: process.env.PATH,
      GIT_SPY_LOG: process.env.GIT_SPY_LOG,
      GIT_SPY_REAL: process.env.GIT_SPY_REAL,
    };

    fs.writeFileSync(spy.log, "");

    process.env.GIT_SPY_LOG = spy.log;
    process.env.GIT_SPY_REAL = real;
    process.env.PATH = directory + path.delimiter + process.env.PATH;
  };

  spy.restore = function () {
    if (!saved) return;

    ["PATH", "GIT_SPY_LOG", "GIT_SPY_REAL"].forEach(function (name) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    });

    delete process.env.GIT_SPY_SLEEP;
    fs.removeSync(saved.directory);
    saved = null;
  };

  // In the order they started, with whether they have ended
  function read() {
    var started = [];
    var byPid = {};

    fs.readFileSync(spy.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .forEach(function (line) {
        var fields = line.split("\t");

        if (fields[0] === "start") {
          var command = { pid: fields[1], gitDir: fields[2], cwd: fields[3], args: fields[4], ended: false };
          started.push(command);
          byPid[command.pid] = command;
        } else if (byPid[fields[1]]) {
          byPid[fields[1]].ended = true;
        }
      });

    return started;
  }

  spy.commands = function (filter) {
    return read().filter(filter || Boolean);
  };

  spy.mostAtOnce = function (filter) {
    var picked = {};
    var running = 0;
    var most = 0;

    read()
      .filter(filter || Boolean)
      .forEach(function (command) {
        picked[command.pid] = true;
      });

    fs.readFileSync(spy.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .forEach(function (line) {
        var fields = line.split("\t");

        if (!picked[fields[1]]) return;

        running += fields[0] === "start" ? 1 : -1;
        most = Math.max(most, running);
      });

    return most;
  };

  return spy;
};
