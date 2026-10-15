describe("alarm", function () {
  const alarm = require("helper/alarm");
  const client = require("models/client");
  const { randomUUID } = require("crypto");

  beforeEach(function () {
    const spec = this;
    spec.name = "test-" + randomUUID();
    spec.t = 1000000; // fake clock, ms

    spec.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    spec.waitFor = async function (condition) {
      for (let i = 0; i < 200 && !condition(); i++) await spec.sleep(10);
      expect(condition()).toBe(true);
    };

    // Instances in a spec share a name, as two processes would
    spec.make = function (handler, options = {}) {
      return alarm(
        spec.name,
        handler,
        Object.assign({ now: () => spec.t }, options)
      );
    };
  });

  afterEach(async function () {
    await client.del(
      "alarm:due:" + this.name,
      "alarm:claims:" + this.name,
      "alarm:due:" + this.name + ":claims",
      "alarm:claims:" + this.name + ":claims"
    );
  });

  it("does not call the handler before the alarm is due, then handles it once", async function () {
    const calls = [];
    const alarms = this.make(async (id) => calls.push(id));

    await alarms.set("a", this.t + 100);
    expect(await alarms.poll()).toEqual(0);
    expect(calls).toEqual([]);

    this.t += 100;
    expect(await alarms.poll()).toEqual(1);
    expect(calls).toEqual(["a"]);
    expect(await alarms.when("a")).toBe(null);

    expect(await alarms.poll()).toEqual(0);
    expect(calls).toEqual(["a"]);
  });

  it("set replaces an existing time, cancel removes, when reports it", async function () {
    const alarms = this.make(async () => {});

    expect(await alarms.when("a")).toBe(null);
    await alarms.set("a", this.t + 100);
    expect(await alarms.when("a")).toEqual(this.t + 100);

    await alarms.set("a", new Date(this.t + 500));
    expect(await alarms.when("a")).toEqual(this.t + 500);

    await alarms.cancel("a");
    expect(await alarms.when("a")).toBe(null);
    await alarms.cancel("a");
  });

  it("validates its arguments", async function () {
    const alarms = this.make(async () => {});

    expect(() => alarm("", async () => {})).toThrow();
    expect(() => alarm("x", null)).toThrow();
    await expectAsync(alarms.set("", 1)).toBeRejected();
    await expectAsync(alarms.set("a", NaN)).toBeRejected();
    await expectAsync(alarms.set("a", new Date("nope"))).toBeRejected();
    await expectAsync(alarms.set("a", "soon")).toBeRejected();
    await expectAsync(alarms.cancel(5)).toBeRejected();
  });

  it("handles each due id exactly once across two instances", async function () {
    const calls = [];
    const handler = async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.push(id);
    };
    const one = this.make(handler, { batch: 3 });
    const two = this.make(handler, { batch: 3 });
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];

    for (const id of ids) await one.set(id, this.t);

    let total = 0;
    for (let i = 0; i < 4; i++) {
      const counts = await Promise.all([one.poll(), two.poll()]);
      total += counts[0] + counts[1];
    }

    expect(calls.slice().sort()).toEqual(ids);
    expect(total).toEqual(ids.length);
  });

  it("lets exactly one of two racing instances claim a single due id", async function () {
    for (let round = 0; round < 20; round++) {
      const calls = [];
      const handler = async (id) => calls.push(id);
      const one = this.make(handler);
      const two = this.make(handler);

      await one.set("a", this.t);
      const counts = await Promise.all([one.poll(), two.poll()]);

      expect(counts[0] + counts[1]).toEqual(1);
      expect(calls).toEqual(["a"]);
      expect(await one.when("a")).toBe(null);
    }
  });

  it("retries a failed handler only after the lease expires", async function () {
    let attempts = 0;
    const alarms = this.make(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
      },
      { leaseMs: 1000 }
    );
    spyOn(console, "log");

    await alarms.set("a", this.t);
    expect(await alarms.poll()).toEqual(0);
    expect(attempts).toEqual(1);
    expect(await alarms.when("a")).toEqual(this.t + 1000);

    this.t += 999;
    expect(await alarms.poll()).toEqual(0);
    expect(attempts).toEqual(1);

    this.t += 1;
    expect(await alarms.poll()).toEqual(1);
    expect(attempts).toEqual(2);
    expect(await alarms.when("a")).toBe(null);
  });

  it("keeps an alarm that was set again while it was being handled", async function () {
    const later = this.t + 5000;
    const alarms = this.make(async (id) => {
      await alarms.set(id, later);
    });

    await alarms.set("a", this.t);
    expect(await alarms.poll()).toEqual(1);
    expect(await alarms.when("a")).toEqual(later);
  });

  it("keeps an alarm set again to exactly the claimed lease score", async function () {
    const leaseMs = 1000;
    const claimedScore = this.t + leaseMs;
    const alarms = this.make(
      async (id) => {
        await alarms.set(id, claimedScore);
      },
      { leaseMs }
    );

    await alarms.set("a", this.t);
    expect(await alarms.poll()).toEqual(1);
    expect(await alarms.when("a")).toEqual(claimedScore);
  });

  it("renews the lease while a handler is still running", async function () {
    const spec = this;
    let started = false;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const calls = [];
    const one = this.make(
      async (id) => {
        calls.push(id);
        started = true;
        await gate;
      },
      { leaseMs: 1000, renewMs: 20 }
    );
    const two = this.make(async (id) => calls.push(id), {
      leaseMs: 1000,
      renewMs: 20,
    });

    await one.set("a", this.t);
    const first = one.poll();
    await this.waitFor(() => started);

    for (let i = 0; i < 3; i++) {
      spec.t += 600; // well past the original lease by the end
      await this.sleep(200); // ten renewal ticks; one is enough
    }

    expect(await two.poll()).toEqual(0);
    expect(calls).toEqual(["a"]);

    release();
    expect(await first).toEqual(1);
    expect(await one.when("a")).toBe(null);
    expect(await two.poll()).toEqual(0);
    expect(calls).toEqual(["a"]);
  });

  it("does not lease batch items that have not started", async function () {
    let started = false;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const calls = [];
    const one = this.make(
      async (id) => {
        calls.push(id);
        if (id === "a") {
          started = true;
          await gate;
        }
      },
      { batch: 2 }
    );
    const two = this.make(async (id) => calls.push(id), { batch: 2 });

    await one.set("a", this.t);
    await one.set("b", this.t);

    const first = one.poll();
    await this.waitFor(() => started);

    expect(await two.poll()).toEqual(1);
    expect(calls).toEqual(["a", "b"]);

    release();
    expect(await first).toEqual(1);
    expect(calls).toEqual(["a", "b"]);
    expect(await one.when("a")).toBe(null);
    expect(await one.when("b")).toBe(null);
  });

  it("does not resurrect an alarm cancelled while it was being handled", async function () {
    const alarms = this.make(async (id) => {
      await alarms.cancel(id);
    });

    await alarms.set("a", this.t);
    expect(await alarms.poll()).toEqual(1);
    expect(await alarms.when("a")).toBe(null);

    this.t += 100000;
    expect(await alarms.poll()).toEqual(0);
  });

  it("claims at most batch ids per poll", async function () {
    const calls = [];
    const alarms = this.make(async (id) => calls.push(id), { batch: 2 });

    for (const id of ["a", "b", "c", "d", "e"]) await alarms.set(id, this.t);

    expect(await alarms.poll()).toEqual(2);
    expect(await alarms.poll()).toEqual(2);
    expect(await alarms.poll()).toEqual(1);
    expect(await alarms.poll()).toEqual(0);
    expect(calls.slice().sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not run overlapping polls in one instance", async function () {
    const calls = [];
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const alarms = this.make(async (id) => {
      calls.push(id);
      await gate;
    });

    await alarms.set("a", this.t);
    const first = alarms.poll();
    const second = alarms.poll();
    expect(second).toBe(first);

    release();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(calls).toEqual(["a"]);
  });

  it("start polls on a timer and stop ends it", async function () {
    const calls = [];
    const alarms = this.make(async (id) => calls.push(id), { pollMs: 10 });

    await alarms.set("a", this.t);
    alarms.start();
    alarms.start();
    for (let i = 0; i < 100 && !calls.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls).toEqual(["a"]);

    await alarms.stop();
    await alarms.set("b", this.t);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toEqual(["a"]);
    expect(await alarms.when("b")).toEqual(this.t);
  });

  it("stop finishes the handler underway but claims no more of its batch", async function () {
    const calls = [];
    let started = false;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const alarms = this.make(
      async (id) => {
        calls.push(id);
        started = true;
        await gate;
      },
      { batch: 3 }
    );

    for (const id of ["a", "b", "c"]) await alarms.set(id, this.t);

    const first = alarms.poll();
    await this.waitFor(() => started);
    const stopped = alarms.stop();
    release();
    await stopped;

    expect(await first).toEqual(1);
    expect(calls.length).toEqual(1);
    const rest = ["a", "b", "c"].filter((id) => id !== calls[0]);
    for (const id of rest) expect(await alarms.when(id)).toEqual(this.t);

    expect(await alarms.poll()).toEqual(2);
  });

  it("does not handle an id claimed after stop was called", async function () {
    const calls = [];
    const alarms = this.make(async (id) => calls.push(id));
    await alarms.set("a", this.t);

    // Call stop() while the claim is in flight
    const real = client.eval.bind(client);
    let stopped;
    spyOn(client, "eval").and.callFake(async (...args) => {
      const reply = await real(...args);
      if (String(args[0]).includes("ZRANGEBYSCORE") && !stopped) {
        stopped = alarms.stop();
      }
      return reply;
    });

    expect(await alarms.poll()).toEqual(0);
    await stopped;
    expect(calls).toEqual([]);
    expect(await alarms.when("a")).not.toBe(null);
  });

  it("rejects invalid options", function () {
    const make = (options) => () => alarm("x", async () => {}, options);

    expect(make({ leaseMs: 100, renewMs: 100 })).toThrowError(TypeError);
    expect(make({ leaseMs: 100, renewMs: 150 })).toThrowError(TypeError);
    expect(make({ leaseMs: 1 })).toThrowError(TypeError);
    expect(make({ pollMs: 0 })).toThrowError(TypeError);
    expect(make({ pollMs: -5 })).toThrowError(TypeError);
    expect(make({ pollMs: NaN })).toThrowError(TypeError);
    expect(make({ batch: 0 })).toThrowError(TypeError);
    expect(make({ renewMs: 0 })).toThrowError(TypeError);
    expect(make({ leaseMs: 2 })).not.toThrow();
  });

  it("skips a claim whose reply arrived too late to renew in time", async function () {
    const calls = [];
    const alarms = this.make(async (id) => calls.push(id), {
      leaseMs: 200,
      renewMs: 50,
    });
    spyOn(console, "log");

    const real = client.eval.bind(client);
    spyOn(client, "eval").and.callFake(async (script, opts) => {
      const result = await real(script, opts);
      if (script.includes("ZRANGEBYSCORE")) await this.sleep(180);
      return result;
    });

    await alarms.set("a", this.t);
    expect(await alarms.poll()).toEqual(0);
    expect(calls).toEqual([]);
    expect(await alarms.when("a")).toEqual(this.t + 200);
  });

  it("allows names that differ only by a :claims suffix side by side", async function () {
    const calls = [];
    const one = alarm(this.name, async (id) => calls.push("one:" + id), {
      now: () => this.t,
    });
    const two = alarm(
      this.name + ":claims",
      async (id) => calls.push("two:" + id),
      { now: () => this.t }
    );

    await one.set("a", this.t);
    await two.set("a", this.t);
    expect(await one.poll()).toEqual(1);
    expect(await two.poll()).toEqual(1);
    expect(calls.sort()).toEqual(["one:a", "two:a"]);
  });
});
