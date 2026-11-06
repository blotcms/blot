// Runs a job on untrusted bytes, in the sandbox when there is one:
//
//   const { meta, outputs } = await sandbox.run("metadata", {}, buffer);
//
// input is a Buffer or { path }, which is streamed from disk. With no
// config.sandbox.socket the job runs in-process, as in development and where
// there is no broker. With one, it fails closed: whatever goes wrong rejects
// with an Error whose code starts SANDBOX_, and the job is never run in-process.
// See ./README.md.

const fs = require("fs");
const net = require("net");
const config = require("config");
const alerts = require("./alerts");

const JOB = /^[a-z-]+$/;

// The longest job limit in proxy/unit/sandbox/jail.js (75s, the fetch job's
// batch; the screenshot job's is 70s) plus the time a request can be queued behind the broker's
// other jobs (a minute at most, MAX_QUEUED_MS in the broker) and some room. The
// client can't import the broker's table, so until the table is shared, one
// constant.
const TIMEOUT_MS = 150 * 1000;

// Upper bound on what any job may send back (the broker caps each job lower)
const MAX_REPLY_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;

// The errors the broker answers with
const BROKER_ERRORS = [
  "busy",
  "unknown-job",
  "input-too-large",
  "output-too-large",
  "failed",
  "killed",
  "timeout",
];

function sandboxError(code, message) {
  const err = new Error(message || code);
  err.code = "SANDBOX_" + code;
  return err;
}

async function inProcess(job, args, input) {
  if (!JOB.test(job)) throw new Error("unknown job");
  const buffer = Buffer.isBuffer(input)
    ? input
    : await fs.promises.readFile(input.path);
  return require("./jobs/" + job).run(args, buffer);
}

function readLine(buffer, max) {
  const end = buffer.indexOf(10);
  if (end === -1 || end > max) return null;
  return {
    line: buffer.subarray(0, end).toString(),
    rest: buffer.subarray(end + 1),
  };
}

function isLength(n, max) {
  return Number.isSafeInteger(n) && n >= 0 && n <= max;
}

// What the broker sent back, once the socket has closed: its JSON line, then
// the jail's stdout, which is the job's JSON line and the output bytes
function parseReply(reply) {
  const first = readLine(reply, MAX_HEADER_BYTES);
  if (!first) throw sandboxError("BAD_REPLY", "no reply line");

  let header;
  try {
    header = JSON.parse(first.line);
  } catch (e) {
    throw sandboxError("BAD_REPLY", "reply is not JSON");
  }
  if (!header || typeof header !== "object") throw sandboxError("BAD_REPLY");

  if (header.ok === false) {
    if (!BROKER_ERRORS.includes(header.error))
      throw sandboxError("BAD_REPLY", "unknown error");
    throw sandboxError(
      header.error.toUpperCase().replace(/-/g, "_"),
      "sandbox: " + header.error
    );
  }
  if (header.ok !== true || !isLength(header.length, MAX_REPLY_BYTES)) {
    throw sandboxError("BAD_REPLY", "invalid reply");
  }
  if (first.rest.length < header.length)
    throw sandboxError("TRUNCATED", "reply was cut short");
  if (first.rest.length > header.length)
    throw sandboxError("BAD_REPLY", "reply is longer than it says");

  const second = readLine(first.rest, MAX_REPLY_BYTES);
  if (!second) throw sandboxError("BAD_REPLY", "no job line");
  let result;
  try {
    result = JSON.parse(second.line);
  } catch (e) {
    throw sandboxError("BAD_REPLY", "job reply is not JSON");
  }
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray(result.lengths) ||
    !result.lengths.every((n) => isLength(n, MAX_REPLY_BYTES)) ||
    result.lengths.reduce((a, b) => a + b, 0) !== second.rest.length
  ) {
    throw sandboxError("BAD_REPLY", "job reply lengths do not match");
  }

  let offset = 0;
  const outputs = result.lengths.map((n) => {
    const output = Buffer.from(second.rest.subarray(offset, offset + n));
    offset += n;
    return output;
  });
  return { meta: result.meta, outputs };
}

function viaBroker(socketPath, job, args, input) {
  return new Promise((resolve, reject) => {
    if (!JOB.test(job))
      return reject(sandboxError("UNKNOWN_JOB", "unknown job"));
    if (!Buffer.isBuffer(input) && !(input && typeof input.path === "string")) {
      return reject(
        sandboxError("INPUT", "input must be a Buffer or { path }")
      );
    }

    const chunks = [];
    let size = 0;
    let connectError = null;
    let done = false;
    let file = null;

    const socket = net.connect(socketPath);

    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (file) file.destroy();
      err ? reject(err) : resolve(result);
    };

    const timer = setTimeout(
      () => finish(sandboxError("TIMEOUT", "sandbox did not answer in time")),
      TIMEOUT_MS
    );

    // The broker may answer (busy, too large) and close before it has read all
    // we send, so a write error is not yet a failure: the reply says which
    socket.on("error", (err) => {
      connectError = err;
    });
    socket.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REPLY_BYTES + MAX_HEADER_BYTES * 2) {
        return finish(sandboxError("BAD_REPLY", "reply is too long"));
      }
      chunks.push(chunk);
    });
    socket.on("close", () => {
      if (done) return;
      if (!size && connectError) {
        return finish(
          sandboxError(
            "UNAVAILABLE",
            "cannot reach the sandbox: " + connectError.code
          )
        );
      }
      try {
        finish(null, parseReply(Buffer.concat(chunks)));
      } catch (err) {
        finish(err);
      }
    });

    socket.write(
      JSON.stringify({ job }) + "\n" + JSON.stringify(args || {}) + "\n"
    );

    if (Buffer.isBuffer(input)) return socket.end(input);

    file = fs.createReadStream(input.path);
    file.on("error", (err) =>
      finish(sandboxError("INPUT", "cannot read input: " + err.code))
    );
    file.pipe(socket);
  });
}

async function run(job, args, input) {
  const socketPath = config.sandbox.socket;
  if (!socketPath) return inProcess(job, args, input);
  try {
    return await viaBroker(socketPath, job, args, input);
  } catch (err) {
    alerts.jobFailed(job, err);
    throw err;
  }
}

module.exports = { run };
