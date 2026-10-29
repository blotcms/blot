describe("workerChild", function () {
  const EventEmitter = require("events");
  const workerChild = require("helper/workerChild");

  let forks, supervisor;

  // Stands in for child_process.fork: records each fork and lets the spec
  // end the child, as an exit or a kill would
  function fakeFork(script, args, options) {
    const child = new EventEmitter();
    child.pid = 1000 + forks.length;
    child.script = script;
    child.options = options;
    child.kill = jasmine.createSpy("kill").and.callFake(function (signal) {
      setImmediate(() => child.emit("exit", 0, null));
    });
    forks.push(child);
    return child;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Waits until there have been n forks, so a slow CI runner's late timer
  // doesn't fail a spec that only checks a retry happens
  async function forked(n) {
    for (let i = 0; i < 100 && forks.length < n; i++) await wait(10);
    expect(forks.length).toBe(n);
  }

  function start(options = {}) {
    supervisor = workerChild(
      Object.assign(
        {
          script: "/app/index.js",
          socket: "/run/blot/a-worker.sock",
          fork: fakeFork,
          env: { CONTAINER_NAME: "blot-container-a", BLOT_WORKER_SOCKET: "/run/blot/a-worker.sock" },
          minBackoffMs: 20,
          maxBackoffMs: 80,
          stableMs: 1000,
        },
        options
      )
    );
    return supervisor;
  }

  beforeEach(function () {
    forks = [];
    spyOn(console, "log");
  });

  afterEach(async function () {
    if (supervisor) await supervisor.stop();
    supervisor = null;
  });

  it("forks the script to serve on the socket alone", function () {
    start({ maxOldSpaceSize: 900, drainTimeoutMs: 25000 });

    expect(forks.length).toBe(1);
    const { env, execArgv } = forks[0].options;
    expect(forks[0].script).toBe("/app/index.js");
    expect(env.BLOT_WORKER_CHILD).toBe("true");
    expect(env.BLOT_SOCKET).toBe("/run/blot/a-worker.sock");
    expect(env.BLOT_WORKER_SOCKET).toBe("");
    expect(env.CONTAINER_NAME).toBe("blot-container-a");
    expect(env.BLOT_DRAIN_TIMEOUT_MS).toBe("22000");
    expect(env.BLOT_CACHE_SCALE).toBe("0.1");
    expect(execArgv).toContain("--max-old-space-size=900");
  });

  it("takes the child's render cache scale from the environment", function () {
    start({
      env: { BLOT_CACHE_SCALE: "1", BLOT_WORKER_CACHE_SCALE: "0.5" },
    });

    expect(forks[0].options.env.BLOT_CACHE_SCALE).toBe("0.5");
  });

  it("forks it again after it exits, backing off", async function () {
    start();

    forks[0].emit("exit", 1, null);
    expect(forks.length).toBe(1);
    await forked(2);

    // The second delay is double the first
    forks[1].emit("exit", 1, null);
    await wait(25);
    expect(forks.length).toBe(2);
    await wait(40);
    expect(forks.length).toBe(3);
  });

  it("retries a child that fails to spawn, without crashing", async function () {
    const realFork = fakeFork;
    let failed = false;
    start({
      fork: function () {
        const child = realFork.apply(null, arguments);
        if (!failed) {
          failed = true;
          child.pid = undefined;
          // Spawn failures arrive as "error" (fatal unless handled), and
          // sometimes "exit" too: one restart either way
          setImmediate(() => {
            child.emit("error", new Error("EAGAIN"));
            child.emit("exit", null, null);
          });
        }
        return child;
      },
    });

    await forked(2);
    await wait(60);
    expect(forks.length).toBe(2);
  });

  it("retries when fork itself throws", async function () {
    let threw = false;
    start({
      fork: function () {
        if (!threw) {
          threw = true;
          throw new Error("EMFILE");
        }
        return fakeFork.apply(null, arguments);
      },
    });

    expect(forks.length).toBe(0);
    await forked(1);
  });

  it("stops the child with SIGTERM and resolves once it has exited", async function () {
    start();

    await supervisor.stop();

    expect(forks[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(supervisor.pid).toBe(null);
  });

  it("calls onExit for a child that dies, not for one it stops", async function () {
    const onExit = jasmine.createSpy("onExit");
    start({ onExit });

    forks[0].emit("exit", null, "SIGKILL");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith("Exited pid=1000 code=null signal=SIGKILL");

    await wait(40);
    await supervisor.stop();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("forks it again even if onExit throws", async function () {
    start({
      onExit: function () {
        throw new Error("no mail");
      },
    });

    forks[0].emit("exit", 1, null);
    await forked(2);
  });

  it("forks nothing more once stopped, even while a restart is pending", async function () {
    start();

    forks[0].emit("exit", 1, null);
    await supervisor.stop();
    await wait(60);

    expect(forks.length).toBe(1);
  });
});
