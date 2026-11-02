// The host's gate on the git processes the store runs (README, "Limiting
// git"): a push through receive() and a compaction start every one of them
// through it, none before it lets them, and work without one as before. The
// git processes are seen by a `git` put first on PATH which logs when it
// starts and ends; the gate logs to the same file.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const { createReceiveServer, push } = require("./helpers/receiveServer");
const manifest = require("../manifest");
const compact = require("../compact");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const { createSemaphore, createChildren } = require("../limit");

const MiB = 1024 * 1024;

const SCRIPT = [
  "#!/bin/sh",
  'echo "start $$" >> "$STORE_SPY_LOG"',
  '"$STORE_SPY_REAL" "$@"',
  "code=$?",
  'echo "end $$" >> "$STORE_SPY_LOG"',
  "exit $code",
  "",
].join("\n");

function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

describe("git store gate", function () {
  timeout(120 * 1000);

  let dir;
  let log;
  let saved;

  beforeEach(function () {
    dir = fx.tempDir();
    log = path.join(dir, "log");
    fs.writeFileSync(log, "");

    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), SCRIPT, { mode: 0o755 });

    saved = { PATH: process.env.PATH };
    process.env.STORE_SPY_REAL = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    process.env.STORE_SPY_LOG = log;
    process.env.PATH = bin + path.delimiter + process.env.PATH;
  });

  afterEach(function () {
    process.env.PATH = saved.PATH;
    delete process.env.STORE_SPY_LOG;
    delete process.env.STORE_SPY_REAL;
    fx.remove(dir);
  });

  // A gate which lets one git run at a time, and logs when it lets one start
  // and when it has closed
  function serialGate() {
    const acquire = createSemaphore(1);
    const gate = async (start) => {
      const release = await acquire();
      gate.calls++;
      fs.appendFileSync(log, "gate\n");
      try {
        return await start();
      } finally {
        fs.appendFileSync(log, "closed\n");
        release();
      }
    };
    gate.calls = 0;
    return gate;
  }

  function lines() {
    return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")[0]);
  }

  // Ignoring the spec's own git (the client's push and the fixture), every
  // git the store ran started after the gate let it and ended before the gate
  // heard it had closed, one at a time
  function expectGated(entries, gate) {
    const store = [];
    let open = false;
    let inside = 0;

    for (const entry of entries) {
      if (entry === "gate") {
        expect(open).toBe(false);
        open = true;
        store.push([]);
      } else if (entry === "closed") {
        open = false;
      } else if (open) {
        store[store.length - 1].push(entry);
        inside++;
      }
    }

    expect(store.length).toBe(gate.calls);
    // Each call of start ran one git, which ended inside it
    store.forEach((run) => expect(run).toEqual(["start", "end"]));
    expect(inside).toBe(2 * gate.calls);
  }

  it("starts every git of a push and of a compaction through the gate", async function () {
    const work = path.join(dir, "work");
    fx.buildFixture(work, { commits: 3, large: false });

    const store = createMemoryStore();
    const cache = createCache({ dir: path.join(dir, "cache"), maxBytes: 64 * MiB });
    const pushes = serialGate();
    const server = await createReceiveServer({ store, cache, lock: createLock(), gate: pushes });

    try {
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(work, "posts", "gated-" + i + ".md"), "Gated push " + i + "\n");
        fx.git(work, ["add", "-A"]);
        fx.git(work, ["commit", "-q", "-m", "Gated push " + i]);

        // The client's own git runs outside the gate: only lines between a
        // gate and its close are the store's
        const result = await push(work, ["-q", server.url, "master"]);
        if (result.code !== 0) throw new Error("git push failed: " + result.stderr);
      }
    } finally {
      await server.close();
    }

    expect(server.results.map((result) => result.outcome)).toEqual(["ok", "ok", "ok"]);
    expect(pushes.calls).toBeGreaterThanOrEqual(3 * 2);

    fs.writeFileSync(log, "");
    const background = serialGate();
    const result = await compact({ store, cache, lock: createLock(), gate: background, keepRecent: 0, minPieces: 2 });

    expect(result.outcome).toBe("compacted");
    expect(background.calls).toBeGreaterThanOrEqual(2);
    expectGated(lines(), background);

    // And the result is a repository git agrees with
    const current = await manifest.read(store);
    expect(current.refs["refs/heads/master"]).toBe(fx.text(work, ["rev-parse", "HEAD"]));
  });

  it("starts nothing until the gate lets it, and passes on what the gate does", async function () {
    const children = createChildren((start) => Promise.reject(new Error("no room")));
    const { git } = require("../compact");

    await expectAsync(git.runGit(children, ["init", "-q", "--bare", path.join(dir, "never.git")], { gitDir: path.join(dir, "never.git") })).toBeRejectedWithError("no room");

    expect(lines()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "never.git"))).toBe(false);
  });

  it("runs git at once without a gate", async function () {
    const children = createChildren();
    const { git } = require("../compact");
    const gitDir = path.join(dir, "plain.git");

    await git.runGit(children, ["init", "-q", "--bare", gitDir], { gitDir });

    expect(lines()).toEqual(["start", "end"]);
    expect(() => createChildren("not a function")).toThrowError(/gate must be a function/);
  });
});
