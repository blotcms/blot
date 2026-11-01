// The sandbox broker. Runs as root inside the unit, started by the supervisor
// (proxy/unit/supervisor.sh) with a clean environment, because a jail with its
// own uid and cgroups has to be started by root. Node (uid 1000) talks to it on
// a Unix socket only its group can reach; the protocol is in app/sandbox/README.md.
//
// This file and its siblings are owned by root and read-only to the app (the
// Dockerfile copies them to /usr/local/lib/blot-sandbox): root must never load
// code from /usr/src/app, which the app can rewrite. So it requires only Node
// built-ins and ./jail. It takes no paths, never parses job output and never
// touches the data mount.

const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");
const jail = require("./jail");

const DIRECTORY = "/run/blot-sandbox";
const SOCKET = DIRECTORY + "/broker.sock";
// The app's group. The directory stays root's: chown follows symlinks, so root
// must never chown a path in a directory the app could write to.
const GROUP = 1000;
const MAX_RUNNING = 4;
const MAX_QUEUED = 32;
const MAX_HEADER_BYTES = 4096;
// nsjail enforces the job's time limit itself; this is for when it doesn't
const KILL_GRACE_MS = 2000;
const DRAIN_MS = 10 * 1000;
// A paused socket can't tell us its client left, and the client gives up by
// now, so a request that has waited this long gets no jail
const MAX_QUEUED_MS = 60 * 1000;

// options: { socket, group, spawnJail(name) -> child process, jobs, maxRunning,
// maxQueued, log }. The defaults are the real ones; tests replace spawnJail.
function createBroker(options = {}) {
  const socketPath = options.socket || SOCKET;
  const jobs = options.jobs || jail.JOBS;
  const maxRunning = options.maxRunning || MAX_RUNNING;
  const maxQueued = options.maxQueued === undefined ? MAX_QUEUED : options.maxQueued;
  const maxQueuedMs = options.maxQueuedMs === undefined ? MAX_QUEUED_MS : options.maxQueuedMs;
  const log = options.log || console.error;
  const spawnJail =
    options.spawnJail ||
    ((name) => {
      const { file, args } = jail.command(name);
      return spawn(file, args, { stdio: ["pipe", "pipe", "ignore"], env: {} });
    });
  // What is left of a job in its own cgroup goes with it: a job's cgroup holds
  // that one job, which is why such a job has a maxRunning of 1
  const clearCgroup =
    options.clearCgroup ||
    ((directory) => fs.writeFileSync(directory + "/cgroup.kill", "1"));

  const running = new Set();
  const queue = [];
  const sockets = new Set();

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    readHeader(socket);
  });

  function reply(socket, header, body) {
    if (socket.destroyed) return;
    socket.end(body ? Buffer.concat([Buffer.from(header + "\n"), body]) : header + "\n");
    // A client still sending (we refused its input) only reads the reply once
    // its writes finish, so throw the rest away, for a while
    socket.resume();
    setTimeout(() => socket.destroy(), DRAIN_MS).unref();
  }

  const fail = (socket, error) => reply(socket, JSON.stringify({ ok: false, error }));

  // The first line is the job; everything after it belongs to the jail
  function readHeader(socket) {
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(10);
      if (end === -1) {
        if (buffered.length > MAX_HEADER_BYTES) {
          socket.removeListener("data", onData);
          fail(socket, "unknown-job");
        }
        return;
      }
      socket.removeListener("data", onData);
      socket.pause();
      let name;
      try {
        name = JSON.parse(buffered.subarray(0, end).toString()).job;
      } catch (e) {}
      if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(jobs, name)) {
        return fail(socket, "unknown-job");
      }
      admit({ socket, name, job: jobs[name], rest: buffered.subarray(end + 1) });
    };
    socket.on("data", onData);
    // a client that sends no job line at all
    socket.once("end", () => {
      if (!buffered.includes(10)) fail(socket, "unknown-job");
    });
  }

  // A job may have its own limit, below the broker's
  function hasRoom({ name, job }) {
    if (running.size >= maxRunning) return false;
    if (!job.maxRunning) return true;
    let same = 0;
    for (const entry of running) if (entry.name === name) same++;
    return same < job.maxRunning;
  }

  function admit(request) {
    if (hasRoom(request)) return start(request);
    if (queue.length >= maxQueued) return fail(request.socket, "busy");
    request.queued = Date.now();
    queue.push(request);
    // a client that gives up while queued never gets a jail
    request.socket.once("close", () => {
      const i = queue.indexOf(request);
      if (i !== -1) queue.splice(i, 1);
    });
  }

  function next() {
    // Oldest first, passing over a job that is at its own limit
    for (let i = 0; i < queue.length && running.size < maxRunning; ) {
      const request = queue[i];
      if (request.socket.destroyed) queue.splice(i, 1);
      else if (Date.now() - request.queued > maxQueuedMs) {
        queue.splice(i, 1);
        fail(request.socket, "busy");
      } else if (hasRoom(request)) {
        queue.splice(i, 1);
        start(request);
      } else i++;
    }
  }

  function start({ socket, name, job, rest }) {
    const started = Date.now();
    let failure = null;
    let finished = false;
    let inputBytes = 0;
    let outputBytes = 0;
    const output = [];

    let child;
    try {
      child = spawnJail(name);
    } catch (e) {
      return fail(socket, "failed");
    }
    const entry = { child, name };
    running.add(entry);

    const kill = (error) => {
      if (!failure) failure = error || "disconnected";
      if (child.exitCode !== null || child.signalCode !== null) return;
      // SIGTERM lets nsjail kill the jail and remove its cgroup
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };

    const limit = setTimeout(() => kill("timeout"), job.timeSeconds * 1000 + KILL_GRACE_MS);

    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(limit);
      running.delete(entry);
      if (job.cgroup) {
        try {
          clearCgroup(job.cgroup);
        } catch (e) {
          log(`broker: job=${name} cannot clear its cgroup: ${e.code}`);
        }
      }
      const ms = Date.now() - started;

      let error = failure;
      if (!error && code !== 0) {
        error = signal ? "killed" : "failed";
        if (ms >= job.timeSeconds * 1000) error = "timeout";
      }
      if (error) {
        log(`broker: job=${name} error=${error} code=${code} signal=${signal} ms=${ms}`);
        fail(socket, error);
      } else {
        const body = Buffer.concat(output, outputBytes);
        reply(socket, JSON.stringify({ ok: true, length: body.length }), body);
      }
      next();
    };

    child.on("error", () => {
      if (!failure) failure = "failed";
      finish(null, null);
    });
    child.on("close", finish);
    // a jail we killed may leave something holding its stdout open, which
    // would delay "close"; its output is thrown away anyway
    child.on("exit", (code, signal) => {
      if (failure) finish(code, signal);
    });

    // The client went away before the jail finished. A client that has
    // half-closed (its way of ending the input) and then vanishes looks the
    // same as one that is waiting, so that jail runs to its time limit.
    socket.on("close", () => {
      if (!finished) kill();
    });

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > job.maxOutputBytes) {
        output.length = 0;
        outputBytes = 0;
        return kill("output-too-large");
      }
      if (!failure) output.push(chunk);
    });
    child.stdout.on("error", () => {});

    child.stdin.on("error", () => {});
    const feed = (chunk) => {
      if (failure) return;
      inputBytes += chunk.length;
      if (inputBytes > job.maxInputBytes) {
        socket.pause();
        return kill("input-too-large");
      }
      if (!child.stdin.writable) return;
      if (!child.stdin.write(chunk)) {
        socket.pause();
        child.stdin.once("drain", () => socket.resume());
      }
    };

    if (rest.length) feed(rest);
    socket.on("data", feed);
    // a queued client may have finished sending while it waited
    if (socket.readableEnded) child.stdin.end();
    else socket.on("end", () => child.stdin.end());
    if (!failure) socket.resume();
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const directory = require("path").dirname(socketPath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o710 });
      if (options.group !== undefined) fs.chownSync(directory, 0, options.group);
      fs.chmodSync(directory, 0o710);
      // a stale socket from a previous broker
      fs.rmSync(socketPath, { force: true });
      server.once("error", reject);
      const umask = process.umask(0o117);
      server.listen(socketPath, () => {
        process.umask(umask);
        try {
          if (options.group !== undefined) fs.chownSync(socketPath, 0, options.group);
          fs.chmodSync(socketPath, 0o660);
        } catch (e) {
          return reject(e);
        }
        resolve();
      });
    });
  }

  // Stop listening and kill what is running
  function close() {
    server.close();
    queue.length = 0;
    for (const { child } of running) child.kill("SIGTERM");
    for (const socket of sockets) socket.destroy();
    fs.rmSync(socketPath, { force: true });
  }

  return { listen, close, server, running, queue };
}

module.exports = { createBroker, DIRECTORY, SOCKET };

if (require.main === module) {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    console.error("broker: must run as root");
    process.exit(1);
  }
  const broker = createBroker({ group: GROUP });
  broker.listen().then(
    () => console.log(`broker: listening on ${SOCKET}`),
    (err) => {
      console.error("broker: cannot listen:", err.message);
      process.exit(1);
    }
  );
  const stop = () => {
    broker.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
