describe("helper/lock lock", function () {
  const lock = require("helper/lock");
  const client = require("models/client");
  const { randomUUID } = require("crypto");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(condition, ms = 3000) {
    const end = Date.now() + ms;
    while (!condition() && Date.now() < end) await sleep(20);
    return condition();
  }

  const prefix = "test:helper-lock:lock:" + randomUUID() + ":";
  let n = 0;
  const keys = [];
  const newKey = () => {
    const key = prefix + n++;
    keys.push(key);
    return key;
  };

  afterAll(async function () {
    if (keys.length) await client.del(keys);
  });

  it("is exclusive while held and rejects with ELOCKED", async function () {
    const key = newKey();
    const first = await lock(key);
    let error;
    try {
      try {
        await lock(key);
      } catch (e) {
        error = e;
      }
      expect(error && error.code).toEqual("ELOCKED");
    } finally {
      await first.release();
    }
    const second = await lock(key);
    await second.release();
  });

  it("succeeds on retry once the holder releases", async function () {
    const key = newKey();
    const first = await lock(key);
    setTimeout(() => first.release(), 100);
    const second = await lock(key, { retries: 3, minTimeout: 100 });
    try {
      expect(await client.get(key)).toEqual(second.token);
    } finally {
      await second.release();
    }
  });

  it("gives up with ELOCKED when retries are exhausted", async function () {
    const key = newKey();
    const first = await lock(key);
    let error;
    try {
      try {
        await lock(key, { retries: 1, minTimeout: 20 });
      } catch (e) {
        error = e;
      }
      expect(error && error.code).toEqual("ELOCKED");
    } finally {
      await first.release();
    }
  });

  it("is safe to release twice", async function () {
    const key = newKey();
    const held = await lock(key);
    await held.release();
    await held.release();
    expect(await client.get(key)).toBeNull();
  });

  it("does not delete another holder's lock when released after losing it", async function () {
    const key = newKey();
    const first = await lock(key, { heartbeat: 10000 });
    // The key goes before the watchdog notices, and someone else takes it
    await client.del(key);
    const second = await lock(key);
    try {
      let error;
      try {
        await first.release();
      } catch (e) {
        error = e;
      }
      expect(error && error.code).toEqual("ECOMPROMISED");
      expect(await client.get(key)).toEqual(second.token);
    } finally {
      await second.release();
    }
  });

  it("keeps the lock alive past its ttl with the heartbeat", async function () {
    const key = newKey();
    const held = await lock(key, { ttl: 1500, heartbeat: 100 });
    try {
      await sleep(2000);
      expect(await client.get(key)).toEqual(held.token);
      let error;
      try {
        await lock(key);
      } catch (e) {
        error = e;
      }
      expect(error && error.code).toEqual("ELOCKED");
    } finally {
      await held.release();
    }
  });

  it("calls onCompromised once if the key is deleted underneath", async function () {
    const key = newKey();
    const compromised = [];
    const held = await lock(key, {
      ttl: 1000,
      heartbeat: 30,
      onCompromised: (e) => compromised.push(e),
    });
    try {
      await client.del(key);
      await sleep(250);
      expect(compromised.length).toEqual(1);
      expect(compromised[0].code).toEqual("ECOMPROMISED");
    } finally {
      await held.release().catch(() => {});
    }
    expect(compromised.length).toEqual(1);
  });

  it("calls onCompromised if the key is changed underneath", async function () {
    const key = newKey();
    const compromised = [];
    const held = await lock(key, {
      ttl: 1000,
      heartbeat: 30,
      onCompromised: (e) => compromised.push(e),
    });
    try {
      await client.set(key, "someone-else");
      await sleep(250);
      expect(compromised.length).toEqual(1);
      expect(await client.get(key)).toEqual("someone-else");
    } finally {
      await held.release().catch(() => {});
    }
  });

  it("rejects a stale acquire reply and releases the key", async function () {
    spyOn(console, "error");
    const key = newKey();
    const original = client.set.bind(client);
    let calls = 0;
    spyOn(client, "set").and.callFake(async (...args) => {
      const first = ++calls === 1;
      const result = await original(...args);
      // The reply to the first acquire arrives after staleAfter (250ms) but
      // well before the key would expire on its own (1000ms)
      if (first) await sleep(400);
      return result;
    });
    spyOn(client, "eval").and.callThrough();
    let error;
    try {
      await lock(key, { ttl: 1000, heartbeat: 10000, retries: 0 });
    } catch (e) {
      error = e;
    }
    expect(error && error.code).toEqual("ESLOW");
    await sleep(50);
    expect(client.set).toHaveBeenCalledTimes(1);
    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(client.eval.calls.argsFor(0)[0]).toContain("DEL");
    expect(await client.get(key)).toBeNull();
  });

  it("timestamps the winning attempt, not the first try", async function () {
    const key = newKey();
    const other = await lock(key);
    const started = Date.now();
    setTimeout(() => other.release(), 250);
    const held = await lock(key, { retries: 2, minTimeout: 200 });
    try {
      const acquiredAt = Date.now();
      const since = await lock.heldSince(key);
      expect(since).toBeGreaterThan(started + 200);
      expect(acquiredAt - since).toBeLessThan(150);
    } finally {
      await held.release();
    }
  });

  it("lets release be retried if the command fails", async function () {
    const key = newKey();
    const held = await lock(key);
    spyOn(client, "eval").and.returnValue(
      Promise.reject(new Error("redis down"))
    );
    let error;
    try {
      await held.release();
    } catch (e) {
      error = e;
    }
    client.eval.and.callThrough();
    expect(error && error.message).toEqual("redis down");
    expect(await client.get(key)).toEqual(held.token);
    await held.release();
    expect(await client.get(key)).toBeNull();
    await held.release();
  });

  it("rejects an acquire with no room left for the first heartbeat", async function () {
    spyOn(console, "error");
    const key = newKey();
    const original = client.set.bind(client);
    spyOn(client, "set").and.callFake(async (...args) => {
      const result = await original(...args);
      await sleep(450);
      return result;
    });
    let error;
    try {
      // 1000 - 500 - 2 * 100 = 300ms of the lifetime may be spent; 450 was
      await lock(key, { ttl: 1000, heartbeat: 500 });
    } catch (e) {
      error = e;
    }
    expect(error && error.code).toEqual("ESLOW");
    await sleep(50);
    expect(await client.get(key)).toBeNull();
  });

  it("calls onCompromised once if the heartbeat stalls past the point the key could expire", async function () {
    spyOn(console, "error");
    const key = newKey();
    const compromised = [];
    const held = await lock(key, {
      ttl: 200,
      heartbeat: 30,
      onCompromised: (e) => compromised.push(e),
    });
    // From here on every command hangs, as on a stalled connection
    spyOn(client, "eval").and.callFake(() => new Promise(() => {}));
    await sleep(500);
    expect(compromised.length).toEqual(1);
    expect(compromised[0].code).toEqual("ECOMPROMISED");
    expect(compromised[0].message).toContain("stalled");
    // One EXTEND went out and none was stacked behind it
    expect(client.eval).toHaveBeenCalledTimes(1);
    await sleep(100);
    expect(compromised.length).toEqual(1);
    client.eval.and.callThrough();
    await held.release().catch(() => {});
  });

  it("gives up before the key can expire, not on the first tick after", async function () {
    spyOn(console, "error");
    const key = newKey();
    const compromised = [];
    const before = Date.now();
    const held = await lock(key, {
      ttl: 2000,
      heartbeat: 200,
      onCompromised: () => compromised.push(Date.now()),
    });
    try {
      spyOn(client, "eval").and.returnValue(new Promise(() => {}));
      expect(await until(() => compromised.length > 0, 4000)).toEqual(true);
      // Redis started the countdown no earlier than `before`
      expect(compromised[0]).toBeLessThan(before + 2000);
    } finally {
      client.eval.and.callThrough();
      await held.release().catch(() => {});
    }
  });

  it("contains an onCompromised that throws", async function () {
    spyOn(console, "error");
    const key = newKey();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let calls = 0;
    const held = await lock(key, {
      ttl: 1000,
      heartbeat: 30,
      onCompromised: () => {
        calls++;
        throw new Error("boom");
      },
    });
    try {
      await client.set(key, "someone-else");
      expect(await until(() => calls > 0)).toEqual(true);
      // Give a stray rejection time to surface
      await sleep(100);
      expect(calls).toEqual(1);
      expect(unhandled).toEqual([]);
      const logged = console.error.calls
        .allArgs()
        .some((args) => args[1] === "[LOCK] onCompromised threw");
      expect(logged).toEqual(true);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await held.release().catch(() => {});
    }
  });

  it("contains an async onCompromised that rejects", async function () {
    spyOn(console, "error");
    const key = newKey();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let calls = 0;
    const held = await lock(key, {
      ttl: 1000,
      heartbeat: 30,
      onCompromised: async () => {
        calls++;
        throw new Error("async boom");
      },
    });
    try {
      await client.set(key, "someone-else");
      expect(await until(() => calls > 0)).toEqual(true);
      // Give a stray rejection time to surface
      await sleep(100);
      expect(calls).toEqual(1);
      expect(unhandled).toEqual([]);
      const logged = console.error.calls
        .allArgs()
        .some((args) => args[1] === "[LOCK] onCompromised threw");
      expect(logged).toEqual(true);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await held.release().catch(() => {});
    }
  });

  it("still rejects release with ECOMPROMISED when onCompromised throws", async function () {
    spyOn(console, "error");
    const key = newKey();
    const held = await lock(key, {
      heartbeat: 10000,
      onCompromised: () => {
        throw new Error("boom");
      },
    });
    await client.del(key);
    let error;
    try {
      await held.release();
    } catch (e) {
      error = e;
    }
    expect(error && error.code).toEqual("ECOMPROMISED");
    // Nothing left to retry
    await held.release();
  });

  it("treats a release retried after the key expired naturally as released", async function () {
    const key = newKey();
    const compromised = [];
    const held = await lock(key, {
      ttl: 200,
      heartbeat: 10000,
      onCompromised: (e) => compromised.push(e),
    });
    spyOn(client, "eval").and.returnValue(
      Promise.reject(new Error("redis down"))
    );
    let error;
    try {
      await held.release();
    } catch (e) {
      error = e;
    }
    client.eval.and.callThrough();
    expect(error && error.message).toEqual("redis down");
    // The heartbeat stopped at the first call, so the key runs out on its own
    await sleep(400);
    expect(await client.get(key)).toBeNull();
    await held.release();
    expect(compromised.length).toEqual(0);
  });

  it("treats a release retried after the first one deleted the key as released", async function () {
    const key = newKey();
    const compromised = [];
    const held = await lock(key, {
      heartbeat: 10000,
      onCompromised: (e) => compromised.push(e),
    });
    const original = client.eval.bind(client);
    spyOn(client, "eval").and.callFake(async (...args) => {
      await original(...args);
      throw new Error("reply lost");
    });
    let error;
    try {
      await held.release();
    } catch (e) {
      error = e;
    }
    client.eval.and.callThrough();
    expect(error && error.message).toEqual("reply lost");
    expect(await client.get(key)).toBeNull();
    await held.release();
    expect(compromised.length).toEqual(0);
  });

  it("reports inspect and heldSince", async function () {
    const key = newKey();
    expect((await lock.inspect(key)).held).toEqual(false);
    expect(await lock.heldSince(key)).toBeNull();
    const before = Date.now();
    const held = await lock(key, { ttl: 5000 });
    const info = await lock.inspect(key);
    expect(info.held).toEqual(true);
    expect(info.holder).toEqual(held.token);
    expect(info.ttlMs).toBeGreaterThan(0);
    const since = await lock.heldSince(key);
    expect(since).not.toBeLessThan(before);
    expect(since).not.toBeGreaterThan(Date.now());
    await held.release();
  });
});
