// Specs for the sandbox broker and the nsjail command line. No Docker and no
// root: the broker runs a stub (a shell snippet) in place of nsjail.
const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const jail = require("../jail");
const { createBroker } = require("../broker");

const test = (name, fn) => it(name, fn);

describe("sandbox broker and jail", function () {

// ---- jail.js ----------------------------------------------------------------

test("jail: never --user, never binds /usr or /, disables /proc", () => {
  const argv = jail.args("metadata");
  assert(!argv.includes("--user"));
  assert(argv.includes("--disable_proc"));
  assert(argv.includes("-u") && argv[argv.indexOf("-u") + 1] === "65000:65000:1");
  assert(argv.includes("-g") && argv[argv.indexOf("-g") + 1] === "65000:65000:1");
  const binds = argv.filter((a, i) => argv[i - 1] === "-R");
  assert(binds.length > 0);
  for (const bind of binds) assert(bind !== "/usr" && bind !== "/" && bind !== "/usr/src/app");
  assert(!argv.some((a) => /^(-B|--bindmount)/.test(a)), "no writable binds");
  assert(!argv.includes("--disable_clone_newnet"), "network namespace stays on");
  assert.deepStrictEqual(argv.slice(-3), jail.JOBS.metadata.command);
});

test("jail: passes exactly one environment variable", () => {
  const argv = jail.args("metadata");
  assert.deepStrictEqual(
    argv.filter((a, i) => argv[i - 1] === "-E"),
    ["NODE_PATH=/usr/src/app/node_modules"]
  );
});

test("jail: an unknown job throws", () => {
  for (const name of ["nope", "", undefined, "__proto__", "constructor", "../metadata"]) {
    assert.throws(() => jail.args(name), /unknown job/);
  }
});

test("jail: every job runs its own file in main.js, within its limits", () => {
  assert.deepStrictEqual(Object.keys(jail.JOBS).sort(), ["exif", "favicon", "metadata", "resize", "screenshot", "template-image", "thumbnail", "to-png"]);
  for (const [name, j] of Object.entries(jail.JOBS)) {
    assert.deepStrictEqual(j.command.slice(-2), ["/usr/src/app/app/sandbox/jobs/main.js", name]);
    assert(fs.existsSync(path.join(__dirname, "../../../../app/sandbox/jobs", name + ".js")));
    if (j.network) continue;
    assert.strictEqual(j.memoryBytes, 512 * 1024 * 1024);
    assert.strictEqual(j.maxInputBytes, 256 * 1024 * 1024);
  }
  for (const name of ["thumbnail", "resize", "to-png"]) {
    assert.strictEqual(jail.JOBS[name].timeSeconds, 60);
    assert.strictEqual(jail.JOBS[name].maxOutputBytes, 64 * 1024 * 1024);
  }
  assert.strictEqual(jail.JOBS.exif.timeSeconds, 30);
  assert.strictEqual(jail.JOBS.exif.maxOutputBytes, 1024 * 1024);
});

test("jail: a job with a network starts as its own uid, in its cgroup, behind the filter", () => {
  const { file, args } = jail.command("screenshot");
  assert.strictEqual(file, "/bin/sh");
  assert.strictEqual(args[3], jail.BROWSER_CGROUP);
  assert.deepStrictEqual(args.slice(4, 7), ["/sbin/su-exec", "65001:65001", jail.NSJAIL]);
  assert(args.includes("-u") && args[args.indexOf("-u") + 1] === "65000:65001:1");

  const separator = args.indexOf("--");
  assert.strictEqual(path.basename(args[separator + 2]), "enter-network.sh");
  assert.deepStrictEqual(args.slice(-3), jail.JOBS.screenshot.command);
});

test("jail: a job with a network never binds keys, data or /usr", () => {
  const { args } = jail.command("screenshot");
  const binds = args.filter((a, i) => args[i - 1] === "-R");
  assert(binds.includes("/proc"));
  for (const bind of binds) {
    assert(!["/", "/usr", "/usr/src/app", "/etc", "/etc/ssl", "/run"].includes(bind), bind);
    assert(!bind.startsWith("/etc/ssl/private"), bind);
    assert(!bind.startsWith("/usr/src/app/data"), bind);
  }
  assert(!args.some((a) => /^(-B|--bindmount)/.test(a)), "no writable binds");
});

test("jail: every file a job with a network names exists", () => {
  const { args } = jail.command("screenshot");
  for (const flag of ["--config", "--seccomp_policy"]) {
    assert(fs.existsSync(args[args.indexOf(flag) + 1]), flag);
  }
  assert(fs.existsSync(args[args.indexOf("--") + 2]));
});

test("jail: the proxy jail is its own uid, in its cgroup, behind the filter, with no time limit", () => {
  const { file, args } = jail.proxyCommand("blue");
  assert.strictEqual(file, "/bin/sh");
  assert.strictEqual(args[3], jail.PROXY_CGROUP);
  assert.deepStrictEqual(args.slice(4, 7), ["/sbin/su-exec", "65001:65001", jail.NSJAIL]);
  assert.strictEqual(args[args.indexOf("--time_limit") + 1], "0");
  assert.strictEqual(path.basename(args[args.indexOf("--") + 2]), "enter-network.sh");
  assert(args.includes("BLOT_PROXY_JAIL=1"));
});

test("jail: the proxy jail binds no app, data, keys or /proc", () => {
  const { args } = jail.proxyCommand("blue");
  // Its own scripts are a bind. In the image they are under /usr/local/lib.
  const own = path.dirname(require.resolve("../jail"));
  const binds = args.filter((a, i) => args[i - 1] === "-R" && a !== own);
  for (const bind of binds) {
    assert(!/^\/(proc|etc\/ssl|usr\/src|usr$|$)/.test(bind), bind);
  }
  assert(!args.some((a) => /^(-B|--bindmount)/.test(a)), "no writable binds");
});

test("jail: every job raises its OOM score before nsjail starts, the proxy jail doesn't", () => {
  const raise = `echo ${jail.OOM_SCORE_ADJ} > /proc/self/oom_score_adj && `;
  assert.strictEqual(jail.OOM_SCORE_ADJ, 1000);
  for (const name of Object.keys(jail.JOBS)) {
    const { file, args } = jail.command(name);
    assert.strictEqual(file, "/bin/sh", name);
    assert(args[1].startsWith(raise), name);
  }
  const { args } = jail.command("metadata");
  assert.deepStrictEqual(args.slice(2, 4), ["sh", jail.NSJAIL]);
  assert.deepStrictEqual(args.slice(4), jail.args("metadata"));
  assert(!jail.proxyCommand("blue").args[1].includes("oom_score_adj"));
});

test("jail: the OOM score a job's shell sets reaches the program it execs", function () {
  if (!fs.existsSync("/proc/self/oom_score_adj")) return pending("needs Linux");
  const { args } = jail.command("metadata");
  const script = args[1];
  const { execFileSync } = require("child_process");
  const out = execFileSync("/bin/sh", ["-c", script, "sh", "/bin/cat", "/proc/self/oom_score_adj"]);
  assert.strictEqual(out.toString().trim(), String(jail.OOM_SCORE_ADJ));
});

test("jail: the proxy jail only starts for a unit", () => {
  for (const unit of ["red", "", undefined, "../blue"]) {
    assert.throws(() => jail.proxyCommand(unit), /unknown unit/);
  }
});

test("jail: each proxy config forwards the port the deploy gives that unit, on loopback only", () => {
  const { AIRLOCK } = require("../../../../scripts/deploy/constants");
  for (const unit of ["blue", "green"]) {
    const { args } = jail.proxyCommand(unit);
    const config = fs.readFileSync(args[args.indexOf("--config") + 1], "utf8");
    assert(config.includes(`tcp_ports: "127.0.0.1/${AIRLOCK.units[unit].sandboxProxyPort}:8888"`), unit);
  }
});

test("proxy: makes its cgroup, with limits, and clears what an old jail left", () => {
  const { prepareCgroup } = require("../proxy");
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-proxy-")), "proxy");
  prepareCgroup(directory);
  prepareCgroup(directory);
  assert.strictEqual(fs.readFileSync(directory + "/memory.max", "utf8"), String(128 * 1024 * 1024));
  assert.strictEqual(fs.readFileSync(directory + "/memory.oom.group", "utf8"), "1");
  assert.strictEqual(fs.readFileSync(directory + "/cgroup.kill", "utf8"), "1");
});

// ---- node-filter.js ----------------------------------------------------------

// Runs the program as the kernel would, on one call
function runFilter(lines, { nr, arch, arg0 = 0 }) {
  let accumulator = 0;
  for (let pc = 0; pc < lines.length; pc++) {
    const { code, jt, jf, k } = lines[pc];
    if (code === 0x20) accumulator = { 0: nr, 4: arch, 16: arg0 }[k];
    else if (code === 0x06) return k;
    else if (code === 0x15) pc += accumulator === k ? jt : jf;
    else if (code === 0x35) pc += accumulator >= k ? jt : jf;
    else if (code === 0x45) pc += (accumulator & k) !== 0 ? jt : jf;
    else throw new Error("unknown instruction");
  }
  throw new Error("fell off the end");
}

const ALLOW = 0x7fff0000;
const EPERM = 0x00050001;
const ENOSYS = 0x00050026;

for (const name of ["arm64", "x64"]) {
  const { ARCHES, program } = require("../node-filter");
  const { audit, refused, clone, clone3 } = ARCHES[name];
  const lines = program(name);
  const call = (nr, arg0) => runFilter(lines, { nr, arch: audit, arg0 });

  test(`node filter ${name}: refuses the calls the sandbox added`, () => {
    for (const nr of Object.values(refused)) assert.strictEqual(call(nr), EPERM);
    assert.strictEqual(call(clone3), ENOSYS);
  });

  test(`node filter ${name}: refuses a clone with any namespace flag, allows a plain one`, () => {
    const THREAD = 0x003d0f00;
    const SIGCHLD = 17;
    assert.strictEqual(call(clone, THREAD), ALLOW);
    assert.strictEqual(call(clone, SIGCHLD), ALLOW);
    for (const flag of [0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000]) {
      assert.strictEqual(call(clone, flag | SIGCHLD), EPERM, flag.toString(16));
    }
  });

  test(`node filter ${name}: allows ordinary calls, refuses every call from another arch`, () => {
    for (const nr of [0, 1, 56 + 1000, 221, 63]) assert.strictEqual(call(nr), ALLOW);
    assert.strictEqual(runFilter(lines, { nr: 1, arch: 0x40000028 }), EPERM);
    assert.strictEqual(runFilter(lines, { nr: 1, arch: 0x40000003 }), EPERM);
  });
}

test("node filter x64: refuses x32 calls", () => {
  const { ARCHES, program } = require("../node-filter");
  const lines = program("x64");
  assert.strictEqual(runFilter(lines, { nr: 0x40000000 + 1, arch: ARCHES.x64.audit }), EPERM);
});

test("node filter: encodes to eight bytes a line, in order", () => {
  const { program, encode } = require("../node-filter");
  const lines = program("arm64");
  const buffer = encode(lines);
  assert.strictEqual(buffer.length, lines.length * 8);
  assert.strictEqual(buffer.readUInt16LE(0), lines[0].code);
  assert.strictEqual(buffer.readUInt32LE(4), lines[0].k);
});

test("jail: the filter refuses what the airlock refuses", () => {
  const filter = fs.readFileSync(path.join(__dirname, "../egress.nft"), "utf8");
  for (const range of ["10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "fe80::/10", "::ffff:0:0/96"]) {
    assert(filter.includes(range), range);
  }
  assert(filter.includes('oif "lo" reject'));
});

test("jail: the policy file is the one the flags name", () => {
  const argv = jail.args("metadata");
  const policy = argv[argv.indexOf("--seccomp_policy") + 1];
  assert(fs.existsSync(policy));
});

// ---- broker.js ---------------------------------------------------------------

const JOBS = (extra) => ({
  echo: { command: [], memoryBytes: 0, timeSeconds: 5, maxInputBytes: 1000, maxOutputBytes: 1000, ...extra },
});

let counter = 0;
async function withBroker(options, fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-broker-"));
  const socket = path.join(directory, "broker.sock");
  const script = options.script || "cat";
  const broker = createBroker({
    socket,
    jobs: options.jobs || JOBS(),
    maxRunning: options.maxRunning,
    maxQueued: options.maxQueued,
    maxQueuedMs: options.maxQueuedMs,
    log: () => {},
    clearCgroup: options.clearCgroup,
    spawnJail: () => {
      counter++;
      return spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "ignore"] });
    },
  });
  await broker.listen();
  try {
    await fn(socket, broker);
  } finally {
    broker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Sends header and input, returns { header, body } of the reply
function request(socket, header, input) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    const chunks = [];
    conn.on("data", (c) => chunks.push(c));
    conn.on("error", () => {});
    conn.on("close", () => {
      const all = Buffer.concat(chunks);
      const end = all.indexOf(10);
      if (end === -1) return reject(new Error("no reply line"));
      resolve({ header: JSON.parse(all.subarray(0, end).toString()), body: all.subarray(end + 1) });
    });
    conn.write(header);
    conn.end(input);
  });
}

const job = '{"job":"echo"}\n';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check) {
  for (let i = 0; i < 1000 && !check(); i++) await sleep(5);
  assert(check(), "timed out waiting for the broker");
}

// A stub jail that stays running until release() is called, so a spec can look
// at the broker while jails are busy, however slow the machine is
function hold() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-hold-")), "go");
  return {
    script: `until [ -e ${file} ]; do sleep 0.01; done; cat`,
    release: () => fs.writeFileSync(file, ""),
  };
}

test("broker: bytes after the job line reach the jail and its output comes back", async () => {
  await withBroker({}, async (socket) => {
    const reply = await request(socket, job, "hello world");
    assert.deepStrictEqual(reply.header, { ok: true, length: 11 });
    assert.strictEqual(reply.body.toString(), "hello world");
  });
});

test("broker: the job line and the input may arrive in separate writes", async () => {
  await withBroker({}, async (socket) => {
    const reply = await new Promise((resolve) => {
      const conn = net.connect(socket);
      const chunks = [];
      conn.on("data", (c) => chunks.push(c));
      conn.on("close", () => resolve(Buffer.concat(chunks).toString()));
      conn.write('{"job":');
      setTimeout(() => conn.write('"echo"}\nabc'), 20);
      setTimeout(() => conn.end("def"), 40);
    });
    assert.strictEqual(reply, '{"ok":true,"length":6}\nabcdef');
  });
});

test("broker: an unknown or malformed job is refused before anything starts", async () => {
  await withBroker({}, async (socket) => {
    const before = counter;
    for (const header of ['{"job":"nope"}\n', '{"job":"__proto__"}\n', "garbage\n", '{"job":1}\n', "[]\n"]) {
      const reply = await request(socket, header, "x");
      assert.deepStrictEqual(reply.header, { ok: false, error: "unknown-job" }, header);
    }
    assert.strictEqual(counter, before);
  });
});

test("broker: input over the job's limit is input-too-large", async () => {
  await withBroker({ script: "cat > /dev/null; sleep 5" }, async (socket) => {
    const reply = await request(socket, job, Buffer.alloc(5000, 1));
    assert.deepStrictEqual(reply.header, { ok: false, error: "input-too-large" });
  });
});

test("broker: a client still sending more than the socket holds gets the refusal", async () => {
  await withBroker({ script: "cat > /dev/null; sleep 5" }, async (socket) => {
    const reply = await request(socket, job, Buffer.alloc(16 * 1024 * 1024, 1));
    assert.deepStrictEqual(reply.header, { ok: false, error: "input-too-large" });
  });
});

test("broker: output over the job's limit is output-too-large", async () => {
  await withBroker({ script: "head -c 5000 /dev/zero; sleep 5" }, async (socket) => {
    const reply = await request(socket, job, "");
    assert.deepStrictEqual(reply.header, { ok: false, error: "output-too-large" });
  });
});

test("broker: a jail that exits non-zero is failed, one killed by a signal is killed", async () => {
  await withBroker({ script: "cat > /dev/null; exit 3" }, async (socket) => {
    assert.deepStrictEqual((await request(socket, job, "x")).header, { ok: false, error: "failed" });
  });
  await withBroker({ script: "kill -9 $$" }, async (socket) => {
    assert.deepStrictEqual((await request(socket, job, "x")).header, { ok: false, error: "killed" });
  });
});

test("broker: a jail that outlives its time limit is timeout", async () => {
  await withBroker({ script: "sleep 30", jobs: JOBS({ timeSeconds: 0.1 }) }, async (socket) => {
    assert.deepStrictEqual((await request(socket, job, "x")).header, { ok: false, error: "timeout" });
  });
});

test("broker: close() kills the running jails and removes the socket", async () => {
  await withBroker({ script: "exec sleep 30" }, async (socket, broker) => {
    const conn = net.connect(socket);
    conn.on("error", () => {});
    conn.write(job);
    for (let i = 0; i < 50 && broker.running.size === 0; i++) await sleep(20);
    assert.strictEqual(broker.running.size, 1);
    const [{ child }] = [...broker.running];
    broker.close();
    for (let i = 0; i < 100 && child.signalCode === null; i++) await sleep(20);
    assert.strictEqual(child.signalCode, "SIGTERM");
    assert(!fs.existsSync(socket));
  });
});

test("broker: at most maxRunning jails at once, then a queue, then busy", async () => {
  const held = hold();
  await withBroker({ script: held.script, maxRunning: 2, maxQueued: 1 }, async (socket, broker) => {
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, broker.running.size)), 5);
    const replies = [request(socket, job, "n0"), request(socket, job, "n1")];
    await until(() => broker.running.size === 2);
    replies.push(request(socket, job, "n2"));
    await until(() => broker.queue.length === 1);

    // over the queue's limit
    assert.deepStrictEqual((await request(socket, job, "n3")).header, { ok: false, error: "busy" });
    assert.strictEqual(broker.running.size, 2);
    assert.strictEqual(broker.queue.length, 1);

    held.release();
    const results = await Promise.all(replies);
    clearInterval(watch);
    for (let i = 0; i < 3; i++) {
      assert.deepStrictEqual(results[i].header, { ok: true, length: 2 });
      assert.strictEqual(results[i].body.toString(), "n" + i);
    }
    assert.strictEqual(peak, 2);
  });
});

const line = (name) => JSON.stringify({ job: name }) + "\n";

test("broker: a job with its own maxRunning waits for that, and doesn't hold up others", async () => {
  const jobs = {
    ...JOBS(),
    only: { ...JOBS().echo, maxRunning: 1 },
  };
  const { script, release } = hold();
  await withBroker({ jobs, maxRunning: 4, script }, async (socket, broker) => {
    const first = request(socket, line("only"), "");
    await until(() => broker.running.size === 1);
    const second = request(socket, line("only"), "");
    await until(() => broker.queue.length === 1);
    assert.strictEqual(broker.running.size, 1);

    const other = request(socket, job, "");
    await until(() => broker.running.size === 2);
    assert.strictEqual(broker.queue.length, 1);

    release();
    for (const reply of await Promise.all([first, second, other])) {
      assert.strictEqual(reply.header.ok, true);
    }
  });
});

test("broker: what a job leaves in its cgroup is cleared when it ends, and failing to is logged", async () => {
  const cleared = [];
  const jobs = JOBS({ cgroup: "/some/cgroup" });
  await withBroker(
    { jobs, clearCgroup: (directory) => cleared.push(directory) },
    async (socket) => {
      const { header } = await request(socket, job, "x");
      assert.strictEqual(header.ok, true);
    }
  );
  assert.deepStrictEqual(cleared, ["/some/cgroup"]);

  await withBroker(
    {
      jobs,
      clearCgroup: () => {
        throw Object.assign(new Error("no"), { code: "ENOENT" });
      },
    },
    async (socket) => {
      const { header } = await request(socket, job, "x");
      assert.strictEqual(header.ok, true);
    }
  );
});

test("broker: a request that queued too long is busy, not given a jail", async () => {
  const held = hold();
  await withBroker({ script: held.script, maxRunning: 1, maxQueuedMs: 50 }, async (socket, broker) => {
    const first = request(socket, job, "a");
    await until(() => broker.running.size === 1);
    const second = request(socket, job, "b");
    await until(() => broker.queue.length === 1);
    await sleep(100);
    held.release();
    assert.deepStrictEqual((await first).header, { ok: true, length: 1 });
    assert.deepStrictEqual((await second).header, { ok: false, error: "busy" });
  });
});

test("broker: the socket is 0660 and a stale one is replaced", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-broker-"));
  const socket = path.join(directory, "sub", "broker.sock");
  fs.mkdirSync(path.dirname(socket));
  fs.writeFileSync(socket, "stale");
  const broker = createBroker({ socket, jobs: JOBS(), log: () => {} });
  try {
    await broker.listen();
    assert.strictEqual(fs.statSync(socket).mode & 0o777, 0o660);
    assert.strictEqual(fs.statSync(path.dirname(socket)).mode & 0o777, 0o710);
  } finally {
    broker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

});
