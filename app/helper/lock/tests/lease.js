describe("helper/lock lease", function () {
  const lock = require("helper/lock");
  const client = require("models/client");
  const { randomUUID } = require("crypto");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const options = { ttl: 1500, heartbeat: 100, retryEvery: 100 };
  const key = "test:helper-lock:lease:" + randomUUID();
  const leases = [];
  const start = (fn, opts) => {
    const l = lock.lease(key, fn, Object.assign({}, options, opts));
    leases.push(l);
    return l;
  };

  async function until(condition, ms = 3000) {
    const end = Date.now() + ms;
    while (!condition() && Date.now() < end) await sleep(20);
    return condition();
  }

  const untilAborted = (signal) =>
    new Promise((resolve) => signal.addEventListener("abort", resolve));

  afterEach(async function () {
    await Promise.all(leases.splice(0).map((l) => l.stop()));
    await client.del(key);
  });

  it("runs fn for only one lease at a time", async function () {
    let running = 0;
    let max = 0;
    let started = 0;
    const fn = async (signal) => {
      started++;
      running++;
      max = Math.max(max, running);
      await untilAborted(signal);
      running--;
    };
    start(fn);
    start(fn);
    // Past the ttl, so a holder that stopped renewing would be replaced
    await sleep(1800);
    expect(started).toEqual(1);
    expect(max).toEqual(1);
  });

  it("hands over to the other lease after the holder stops", async function () {
    const log = [];
    const make = (name) => (signal) => {
      log.push(name);
      return untilAborted(signal);
    };
    const a = start(make("a"));
    expect(await until(() => log.length === 1)).toEqual(true);
    start(make("b"));
    await sleep(200);
    expect(log).toEqual(["a"]);
    const aToken = await client.get(key);
    await a.stop();
    // a released its token; b may already hold the key by the time we look
    expect(await client.get(key)).not.toEqual(aToken);
    expect(await until(() => log.length === 2)).toEqual(true);
    expect(log[1]).toEqual("b");
  });

  it("aborts the signal when the key is deleted underneath", async function () {
    spyOn(console, "error");
    let signal;
    start((s) => {
      // Keep the first run's signal: the lease re-acquires afterwards
      if (!signal) signal = s;
      return untilAborted(s);
    });
    expect(await until(() => signal)).toBeTruthy();
    await client.del(key);
    expect(await until(() => signal.aborted)).toEqual(true);
  });

  it("lets the other lease take over after the holder's key is deleted", async function () {
    spyOn(console, "error");
    const log = [];
    const make = (name) => (signal) => {
      log.push(name);
      return untilAborted(signal);
    };
    start(make("a"));
    expect(await until(() => log.length === 1)).toEqual(true);
    start(make("b"));
    await client.del(key);
    // Whoever wins the key next runs; either way fn is entered again
    expect(await until(() => log.length === 2)).toEqual(true);
  });

  it("tries again after fn settles, including when it rejects", async function () {
    spyOn(console, "error");
    let calls = 0;
    start(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    });
    expect(await until(() => calls >= 2)).toEqual(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("defaults retryEvery to ttl so a standby takes over within two ttls", async function () {
    spyOn(console, "error");
    const holder = await lock(key, { ttl: 300, heartbeat: 10000 });
    let enteredAt = null;
    const began = Date.now();
    const l = lock.lease(
      key,
      (signal) => {
        enteredAt = Date.now();
        return untilAborted(signal);
      },
      { ttl: 300, heartbeat: 50 }
    );
    leases.push(l);
    // The holder never heartbeats, so its key expires after 300ms
    expect(await until(() => enteredAt, 2000)).toBeTruthy();
    expect(enteredAt - began).toBeLessThan(1500);
    await holder.release().catch(() => {});
  });

  it("stop while still acquiring never runs fn", async function () {
    const original = client.set.bind(client);
    spyOn(client, "set").and.callFake(async (...args) => {
      const result = await original(...args);
      await sleep(150);
      return result;
    });
    let ran = false;
    const l = start(() => {
      ran = true;
    });
    await l.stop();
    expect(ran).toEqual(false);
    expect(await client.get(key)).toBeNull();
  });

  it("stop resolves, aborts the signal and releases the lock", async function () {
    let signal;
    const l = start((s) => {
      signal = s;
      return untilAborted(s);
    });
    expect(await until(() => signal)).toBeTruthy();
    expect((await lock.inspect(key)).held).toEqual(true);
    await l.stop();
    expect(signal.aborted).toEqual(true);
    expect((await lock.inspect(key)).held).toEqual(false);
  });

  it("stop resolves promptly while waiting to retry", async function () {
    const other = await lock(key, { ttl: 5000 });
    const l = start(() => {}, { retryEvery: 60000 });
    await sleep(100);
    const began = Date.now();
    await l.stop();
    expect(Date.now() - began).toBeLessThan(1000);
    await other.release();
  });
});
