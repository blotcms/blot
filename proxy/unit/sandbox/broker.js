// The sandbox broker. Runs as root inside the unit, started by the supervisor
// (proxy/unit/supervisor.sh) with a clean environment, because a jail with its
// own uid and cgroups has to be started by root. Node (uid 1000) talks to it on
// a Unix socket only its group can reach; the protocol is in app/sandbox/README.md.
//
// This file and its siblings are owned by root and read-only to the app (the
// Dockerfile copies them to /usr/local/lib/blot-sandbox): root must never load
// code from /usr/src/app, which the app can rewrite. So it requires only Node
// built-ins and its siblings. It takes no paths, never parses job output and never
// touches the data mount.

const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");
const cgroup = require("./cgroup");
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

// options: { socket, group, spawnJail(name, cgroup) -> child process, jobs, maxRunning,
// maxQueued, log, prepareCgroup }. The defaults are the real ones; tests
// replace spawnJail.
function createBroker(options = {}) {
  const socketPath = options.socket || SOCKET;
  const jobs = options.jobs || jail.JOBS;
  const maxRunning = options.maxRunning || MAX_RUNNING;
  const maxQueued = options.maxQueued === undefined ? MAX_QUEUED : options.maxQueued;
  const maxQueuedMs = options.maxQueuedMs === undefined ? MAX_QUEUED_MS : options.maxQueuedMs;
  const log = options.log || console.error;
  const spawnJail =
    options.spawnJail ||
    ((name, directory) => {
      const { file, args } = jail.command(name, directory);
      return spawn(file, args, { stdio: ["pipe", "pipe", "ignore"], env: {} });
    });
  // What is left of a job in its own cgroup goes with it: each of a job's
  // cgroups holds one of its jails at a time
  const clearCgroup =
    options.clearCgroup ||
    ((directory) => fs.writeFileSync(directory + "/cgroup.kill", "1"));
  // A job whose cgroup is in the unit's subtree, which nsjail can't make for
  // a jail with a network, has its cgroup made here (./cgroup.js)
  const prepareCgroup = options.prepareCgroup || cgroup.prepare;

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

  // One of the job's cgroups that no jail is in, if it has its own
  function freeCgroup(job) {
    const used = new Set([...running].map((entry) => entry.cgroup));
    return job.cgroups.find((directory) => !used.has(directory));
  }

  // A job may have its own limit, below the broker's, and a jail in its own
  // cgroup needs one of them free
  function hasRoom({ name, job }) {
    if (running.size >= maxRunning) return false;
    if (job.cgroups && !freeCgroup(job)) return false;
    if (!job.maxRunning) return true;
    let same = 0;
    for (const entry of running) if (entry.name === name) same++;
    return same < job.maxRunning;
  }

  // The broker's queue, and a job's own, shorter one if it has one
  function queueIsFull({ name, job }) {
    if (queue.length >= maxQueued) return true;
    if (job.maxQueued === undefined) return false;
    return queue.filter((entry) => entry.name === name).length >= job.maxQueued;
  }

  function admit(request) {
    if (hasRoom(request)) return start(request);
    if (queueIsFull(request)) return fail(request.socket, "busy");
    request.queued = Date.now();
    queue.push(request);
    // a client that gives up while queued never gets a jail
    request.socket.once("close", () => {
      const i = queue.indexOf(request);
      if (i !== -1) queue.splice(i, 1);
    });
  }

  // Jobs that share a cgroup take turns: a job that ran last in the cgroup it
  // is about to use lets another job waiting for it go first. Without this, a
  // big import's batches, queued ahead of a post build's images, would hold the
  // one fetch slot until they were all done.
  const lastNameIn = new Map();
  function yieldsTurn({ name, job }) {
    if (!job.cgroups) return false;
    const directory = freeCgroup(job);
    if (!directory || lastNameIn.get(directory) !== name) return false;
    return queue.some(
      (other) =>
        other.name !== name &&
        !other.socket.destroyed &&
        other.job.cgroups &&
        other.job.cgroups.includes(directory) &&
        hasRoom(other)
    );
  }

  function next() {
    // Oldest first, passing over a job that is at its own limit, or that ran
    // last in a cgroup another waiting job could use
    for (let i = 0; i < queue.length && running.size < maxRunning; ) {
      const request = queue[i];
      if (request.socket.destroyed) queue.splice(i, 1);
      else if (Date.now() - request.queued > maxQueuedMs) {
        queue.splice(i, 1);
        fail(request.socket, "busy");
      } else if (hasRoom(request) && !yieldsTurn(request)) {
        queue.splice(i, 1);
        start(request);
      } else i++;
    }
  }

  function start(request) {
    if (request.job.worker) return startOnWorker(request);
    const { socket, name, job, rest } = request;
    const started = Date.now();
    let failure = null;
    let finished = false;
    let inputBytes = 0;
    let outputBytes = 0;
    const output = [];

    const directory = job.cgroups ? freeCgroup(job) : null;
    let child;
    try {
      child = spawnJail(name, directory);
    } catch (e) {
      return fail(socket, "failed");
    }
    const entry = { child, name, cgroup: directory };
    running.add(entry);
    if (directory) lastNameIn.set(directory, name);

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
      if (directory) {
        try {
          clearCgroup(directory);
        } catch (e) {
          log(`broker: job=${name} cannot clear its cgroup: ${e.code}`);
        }
      }
      const ms = Date.now() - started;

      let error = failure;
      // nsjail exits 128 + the signal when the job inside it was killed, as the
      // kernel does at the jail's memory limit, so that is killed too, not a
      // job that failed on its input
      if (!error && code !== 0) {
        error = signal || code > 128 ? "killed" : "failed";
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

  // A job with `worker` keeps its jails for many requests instead of starting
  // one each (the pandoc job: app/sandbox/jobs/pandoc-worker.lua). A worker
  // takes one request at a time: the client's bytes go to it in frames,
  // "<length>\n<bytes>" and then "0\n", and it answers "<length>\n" and that many
  // bytes, which the client gets as a jail's stdout, or "E\n" for arguments it
  // refuses. A worker that fails, is too slow, or loses its client mid-request
  // is killed. One that has served its requests or its time, or waits idle too
  // long, is retired.
  const idle = new Map();

  function spawnWorker(name) {
    const child = spawnJail(name, null);
    // Its output is kept as chunks and joined once a reply is whole: joining
    // as each arrives would copy a big reply over and over
    const worker = { child, name, started: Date.now(), requests: 0, chunks: [], bytes: 0, onData: null, onExit: null };
    child.stdout.on("data", (chunk) => {
      worker.chunks.push(chunk);
      worker.bytes += chunk.length;
      if (worker.onData) worker.onData();
      else retire(worker); // bytes it was never asked for
    });
    child.stdout.on("error", () => {});
    child.stdin.on("error", () => {});
    const exited = (code, signal) => {
      if (worker.exited) return;
      worker.exited = true;
      unidle(worker);
      if (worker.onExit) worker.onExit(code, signal);
    };
    child.on("error", () => exited(null, null));
    child.on("exit", exited);
    return worker;
  }

  function unidle(worker) {
    const list = idle.get(worker.name);
    const i = list ? list.indexOf(worker) : -1;
    if (i !== -1) list.splice(i, 1);
    clearTimeout(worker.idleTimer);
  }

  function retire(worker) {
    unidle(worker);
    worker.onData = null;
    worker.onExit = null;
    if (worker.exited) return;
    worker.child.stdin.end();
    // SIGTERM lets nsjail kill the jail and remove its cgroup
    setTimeout(() => worker.child.kill("SIGTERM"), KILL_GRACE_MS).unref();
  }

  function kill(worker) {
    worker.onData = null;
    worker.onExit = null;
    unidle(worker);
    if (worker.exited) return;
    worker.child.kill("SIGTERM");
    setTimeout(() => worker.child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }

  function takeWorker(name, job) {
    const list = idle.get(name) || [];
    while (list.length) {
      const worker = list.pop();
      clearTimeout(worker.idleTimer);
      if (!worker.exited) return worker;
    }
    return spawnWorker(name);
  }

  // A worker goes back to wait for the next request, unless it has done its
  // share, or the request was a big one: pandoc's heap may have grown with it,
  // and an idle worker would keep that memory in the unit's sandbox subtree
  function release(worker, job, heavy) {
    worker.onData = null;
    worker.onExit = null;
    const { requests, maxAgeSeconds, idleSeconds, maxIdle } = job.worker;
    const list = idle.get(worker.name) || [];
    idle.set(worker.name, list);
    const old = Date.now() - worker.started > maxAgeSeconds * 1000;
    if (worker.exited || heavy || worker.requests >= requests || old || list.length >= maxIdle) return retire(worker);
    list.push(worker);
    worker.idleTimer = setTimeout(() => retire(worker), idleSeconds * 1000);
    worker.idleTimer.unref();
  }

  function startOnWorker({ socket, name, job, rest }) {
    const started = Date.now();
    let worker;
    try {
      worker = takeWorker(name, job);
    } catch (e) {
      return fail(socket, "failed");
    }
    worker.requests++;
    const entry = { child: worker.child, name, cgroup: null };
    running.add(entry);
    let done = false;
    let inputBytes = 0;

    const finish = (error, body) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      running.delete(entry);
      socket.removeListener("data", feed);
      if (error) {
        log(`broker: job=${name} error=${error} ms=${Date.now() - started}`);
        fail(socket, error);
      } else {
        reply(socket, JSON.stringify({ ok: true, length: body.length }), body);
      }
      next();
    };

    // The worker mid-request is no use to anyone else
    const abandon = (error) => {
      kill(worker);
      finish(error);
    };

    const limit = setTimeout(() => abandon("timeout"), job.worker.requestSeconds * 1000);

    worker.onExit = (code, signal) => {
      // nsjail exits 128 + the signal when the job inside it was killed, as the
      // kernel does at the jail's memory limit
      finish(signal || code > 128 ? "killed" : "failed");
    };

    // The reply's length, once its line has come
    let length = null;
    const keep = (rest) => {
      worker.chunks = rest.length ? [rest] : [];
      worker.bytes = rest.length;
    };

    worker.onData = () => {
      if (length === null) {
        // Until the length line has come there are only a few bytes to join
        const buffer = worker.chunks.length === 1 ? worker.chunks[0] : Buffer.concat(worker.chunks);
        const end = buffer.indexOf(10);
        if (end === -1) {
          if (buffer.length > 32) return abandon("failed");
          return keep(buffer);
        }
        const head = buffer.subarray(0, end).toString();
        keep(buffer.subarray(end + 1));
        if (head === "E") {
          release(worker, job);
          return finish("failed");
        }
        length = /^\d{1,10}$/.test(head) ? Number(head) : -1;
        if (length < 0) return abandon("failed");
        if (length > job.maxOutputBytes) return abandon("output-too-large");
      }
      if (worker.bytes < length) return;
      const all = worker.chunks.length === 1 ? worker.chunks[0] : Buffer.concat(worker.chunks, worker.bytes);
      const body = Buffer.from(all.subarray(0, length));
      keep(all.subarray(length));
      const heavy = inputBytes > job.worker.heavyInputBytes || Date.now() - started > job.worker.heavyMs;
      release(worker, job, heavy);
      finish(null, body);
    };

    const stdin = worker.child.stdin;
    const feed = (chunk) => {
      if (done) return;
      inputBytes += chunk.length;
      if (inputBytes > job.maxInputBytes) {
        socket.pause();
        return abandon("input-too-large");
      }
      stdin.write(chunk.length + "\n");
      if (!stdin.write(chunk)) {
        socket.pause();
        stdin.once("drain", () => socket.resume());
      }
    };
    const end = () => {
      if (!done) stdin.write("0\n");
    };

    // The client went away before the worker answered
    socket.on("close", () => {
      if (!done) abandon("disconnected");
    });

    if (rest.length) feed(rest);
    socket.on("data", feed);
    if (socket.readableEnded) end();
    else socket.on("end", end);
    if (!done) socket.resume();
  }

  // A cgroup that can't be made fails that job's jails, not the broker
  function prepareCgroups() {
    for (const [name, job] of Object.entries(jobs)) {
      if (!job.cgroups || !job.cgroupLimits) continue;
      for (const directory of job.cgroups) {
        try {
          prepareCgroup(directory, job.cgroupLimits);
        } catch (e) {
          log(`broker: job=${name} cannot make its cgroup ${directory}: ${e.code || e.message}`);
        }
      }
    }
  }

  function listen() {
    prepareCgroups();
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
    for (const list of idle.values()) for (const worker of list.slice()) kill(worker);
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
