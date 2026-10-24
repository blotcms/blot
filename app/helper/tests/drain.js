describe("drain", function () {
  const http = require("http");
  const drain = require("helper/drain");

  let server, port;

  function listen(handler) {
    return new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(0, function () {
        port = server.address().port;
        drain.setServer(server);
        resolve();
      });
    });
  }

  function get(agent) {
    return new Promise((resolve, reject) => {
      http
        .get({ port, agent }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        })
        .on("error", reject);
    });
  }

  afterEach(function () {
    drain._reset();
    if (server) {
      server.closeAllConnections();
      if (server.listening) server.close();
    }
    server = null;
  });

  it("lets an in-flight request finish before resolving", async function () {
    await listen((req, res) => setTimeout(() => res.end("ok"), 200));

    const inFlight = get(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    let finished = false;
    const done = drain.start({ timeout: 5000 }).then(() => (finished = true));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(drain.isDraining()).toBe(true);
    expect(finished).toBe(false);
    expect(await inFlight).toBe(200);
    await done;
    expect(finished).toBe(true);
  });

  it("refuses new connections once draining begins", async function () {
    await listen((req, res) => setTimeout(() => res.end("ok"), 200));

    const inFlight = get(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done = drain.start({ timeout: 5000 });

    let code;
    try {
      await get(false);
    } catch (err) {
      code = err.code;
    }

    expect(code).toBe("ECONNREFUSED");
    await inFlight;
    await done;
  });

  it("closes every registered server", async function () {
    await listen((req, res) => res.end("ok"));
    const first = port;
    const other = http.createServer((req, res) => res.end("ok"));
    await new Promise((resolve) => other.listen(0, resolve));
    const second = other.address().port;
    drain.setServer(other);

    await drain.start({ timeout: 1000 });

    for (const p of [first, second]) {
      port = p;
      const err = await get(false).catch((err) => err);
      expect(err.code).toBe("ECONNREFUSED");
    }
  });

  it("calls onStart listeners once", async function () {
    const fn = jasmine.createSpy("listener");
    const off = jasmine.createSpy("unsubscribed");
    drain.onStart(fn);
    drain.onStart(off)();

    await drain.start({ timeout: 1000 });
    await drain.start({ timeout: 1000 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
  });

  it("waits for a promise an onStart listener returns", async function () {
    let finished = false;
    drain.onStart(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            finished = true;
            resolve();
          }, 100)
        )
    );

    await drain.start({ timeout: 1000 });

    expect(finished).toBe(true);
  });

  it("stops waiting for a listener's promise at the timeout", async function () {
    drain.onStart(() => new Promise(() => {}));

    const startedAt = Date.now();
    await drain.start({ timeout: 200 });

    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("gives up after the timeout and closes stuck connections", async function () {
    await listen(() => {});
    get(false).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    await drain.start({ timeout: 300 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
  });

  it("exits 0 after draining on SIGTERM", async function () {
    const exit = jasmine.createSpy("exit");
    const uninstall = drain.install({ timeout: 1000, exit });
    try {
      const exited = new Promise((resolve) => exit.and.callFake(resolve));
      process.emit("SIGTERM");
      await exited;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      uninstall();
    }
  });
});
