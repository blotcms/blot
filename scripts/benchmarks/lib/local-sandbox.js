"use strict";

// Runs sandbox jobs the way production does, minus nsjail: the real broker
// (proxy/unit/sandbox/broker.js) on a socket in a temporary directory, and for
// each job a fresh process running the job's command from
// proxy/unit/sandbox/jail.js (`node app/sandbox/jobs/main.js <job>`), with the
// production paths mapped onto this checkout. So a benchmark pays what
// production pays per job - a socket round trip, a process, Node's start and
// the job's requires - which the in-process path, used whenever
// BLOT_SANDBOX_SOCKET is unset, hides. What it leaves out is nsjail's own
// setup (namespaces, mounts, the cgroup) and its limits.
//
// start() must run before anything requires config, which reads
// BLOT_SANDBOX_SOCKET once when it loads.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "../../..");

// A job's command, with the image's paths swapped for this checkout's
function command(job) {
  return job.command.map((part) => {
    if (part === "/usr/local/bin/node") return process.execPath;
    if (part === "/usr/local/bin/pandoc")
      return process.env.BLOT_PANDOC_PATH || "pandoc";
    return part.replace(/^\/usr\/src\/app\//, ROOT + "/");
  });
}

async function start() {
  if (require.cache[require.resolve(path.join(ROOT, "config"))]) {
    throw new Error("local-sandbox: start() must run before config is loaded");
  }

  const { createBroker } = require(
    path.join(ROOT, "proxy/unit/sandbox/broker")
  );
  const { JOBS } = require(path.join(ROOT, "proxy/unit/sandbox/jail"));

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "blot-bench-sandbox-")
  );
  const socket = path.join(directory, "broker.sock");
  const env = { NODE_PATH: path.join(ROOT, "node_modules") };
  for (const name of ["BLOT_PANDOC_PATH", "EXIFTOOL_PATH", "PATH"]) {
    if (process.env[name]) env[name] = process.env[name];
  }

  let spawned = 0;
  const broker = createBroker({
    socket,
    log: (line) => console.error("[local-sandbox] " + line),
    // No cgroups outside a unit
    prepareCgroup: () => {},
    clearCgroup: () => {},
    spawnJail: (name) => {
      spawned++;
      const [file, ...args] = command(JOBS[name]);
      return spawn(file, args, { stdio: ["pipe", "pipe", "ignore"], env });
    },
  });
  await broker.listen();
  process.env.BLOT_SANDBOX_SOCKET = socket;

  return {
    socket,
    jobs: () => spawned,
    close() {
      broker.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

module.exports = { start };
