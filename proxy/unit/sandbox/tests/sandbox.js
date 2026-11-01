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
  await withBroker({ script: "sleep 0.3; cat", maxRunning: 2, maxQueued: 1 }, async (socket, broker) => {
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, broker.running.size)), 5);
    const replies = [];
    for (let i = 0; i < 4; i++) {
      replies.push(request(socket, job, "n" + i));
      await sleep(30);
    }
    assert.strictEqual(broker.running.size, 2);
    assert.strictEqual(broker.queue.length, 1);
    const results = await Promise.all(replies);
    clearInterval(watch);
    // the fourth was over the queue's limit
    assert.deepStrictEqual(results[3].header, { ok: false, error: "busy" });
    for (let i = 0; i < 3; i++) {
      assert.deepStrictEqual(results[i].header, { ok: true, length: 2 });
      assert.strictEqual(results[i].body.toString(), "n" + i);
    }
    assert.strictEqual(peak, 2);
  });
});

test("broker: a request that queued too long is busy, not given a jail", async () => {
  await withBroker({ script: "sleep 0.2; cat", maxRunning: 1, maxQueuedMs: 50 }, async (socket) => {
    const first = request(socket, job, "a");
    await sleep(30);
    const second = request(socket, job, "b");
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
