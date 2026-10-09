// Lists the git processes in this container that have been running for longer
// than a push or clone can legitimately take. Node's requestTimeout (an hour,
// see app/index.js) ends any request well inside two hours, so these belong to
// a request that is gone and are holding memory and a pack. It is run daily by
// the scheduler (app/scheduler/sweep-git.js).
var execFile = require("child_process").execFile;

var MAX_AGE_SECONDS = 2 * 60 * 60;

var GIT_PROCESS = /^(\S*\/)?git[- ](receive-pack|upload-pack|index-pack)(\s|$)/;

// The container's busybox ps has no `etimes`, only `etime`, which it prints
// as mm:ss, then 2h15 (hours, minutes), then 3d04 (days, hours). procps
// prints [[dd-]hh:]mm:ss.
function parseElapsed(etime) {
  var match = /^(\d+)h(\d+)$/.exec(etime);

  if (match) return Number(match[1]) * 60 * 60 + Number(match[2]) * 60;

  match = /^(\d+)d(\d+)$/.exec(etime);

  if (match) return Number(match[1]) * 24 * 60 * 60 + Number(match[2]) * 60 * 60;

  match = /^(?:(\d+)-)?(\d+(?::\d+){1,2})$/.exec(etime);

  if (!match) return NaN;

  var seconds = match[2].split(":").reduce(function (total, part) {
    return total * 60 + Number(part);
  }, 0);

  return seconds + Number(match[1] || 0) * 24 * 60 * 60;
}

// busybox prints large RSS values with a suffix, e.g. 503m; plain numbers are KB
function parseRssKb(rss) {
  var match = /^(\d+)([mgt]?)$/i.exec(rss);

  if (!match) return NaN;

  return Number(match[1]) * Math.pow(1024, " mgt".indexOf(match[2].toLowerCase() || " "));
}

function ps() {
  return new Promise(function (resolve, reject) {
    execFile("ps", ["-eo", "pid=,etime=,rss=,args="], function (err, stdout) {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// options.ps returns the output of `ps -eo pid=,etime=,rss=,args=`, so a test
// can supply its own
module.exports = async function stuckProcesses(options) {
  options = options || {};

  var maxAgeSeconds =
    options.maxAgeSeconds === undefined ? MAX_AGE_SECONDS : options.maxAgeSeconds;
  var output = await (options.ps || ps)();
  var stuck = [];

  output.split("\n").forEach(function (line) {
    var match = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);

    if (!match || !GIT_PROCESS.test(match[4])) return;

    var seconds = parseElapsed(match[2]);

    if (!(seconds > maxAgeSeconds)) return;

    stuck.push({
      pid: Number(match[1]),
      seconds: seconds,
      rssKb: parseRssKb(match[3]),
      args: match[4],
    });
  });

  return stuck;
};

module.exports.MAX_AGE_SECONDS = MAX_AGE_SECONDS;
