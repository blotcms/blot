describe("helper/lock cron", function () {
  const lock = require("helper/lock");
  const client = require("models/client");
  const { randomUUID } = require("crypto");

  const names = [];
  const newName = () => {
    const name = "test-helper-lock-" + randomUUID();
    names.push(name);
    return name;
  };
  let originalHostID;

  beforeEach(function () {
    originalHostID = process.env.BLOT_HOST_ID;
  });

  afterEach(function () {
    if (originalHostID === undefined) delete process.env.BLOT_HOST_ID;
    else process.env.BLOT_HOST_ID = originalHostID;
  });

  afterAll(async function () {
    for (const name of names) {
      const found = await client.keys("cron:" + name + ":*");
      if (found.length) await client.del(found);
    }
  });

  it("runs fn once when two processes fire with the same date", async function () {
    const name = newName();
    const fireDate = new Date("2030-01-01T00:00:00.000Z");
    const calls = [];
    const fn = (date) => calls.push(date);
    await Promise.all([
      lock.cron._fire(name, fireDate, fn),
      lock.cron._fire(name, fireDate, fn),
    ]);
    expect(calls.length).toEqual(1);
    expect(calls[0]).toEqual(fireDate);
  });

  it("runs again for a different fire date", async function () {
    const name = newName();
    let count = 0;
    const fn = () => count++;
    await lock.cron._fire(name, new Date("2030-01-01T00:00:00.000Z"), fn);
    await lock.cron._fire(name, new Date("2030-01-01T00:01:00.000Z"), fn);
    expect(count).toEqual(2);
  });

  it("builds the key from the fire date", async function () {
    const name = newName();
    const fireDate = new Date("2030-02-03T04:05:00.000Z");
    await lock.cron._fire(name, fireDate, () => {});
    expect(
      await client.exists("cron:" + name + ":" + fireDate.toISOString())
    ).toEqual(1);
  });

  it("keeps the marker for about 24 hours by default", async function () {
    const name = newName();
    const fireDate = new Date("2030-02-03T04:05:00.000Z");
    await lock.cron._fire(name, fireDate, () => {});
    const ttlMs = await client.pTTL("cron:" + name + ":" + fireDate.toISOString());
    expect(ttlMs).toBeGreaterThan(60 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("swallows errors from fn", async function () {
    const name = newName();
    spyOn(console, "error");
    await lock.cron._fire(name, new Date("2030-01-01T00:00:00.000Z"), () => {
      throw new Error("boom");
    });
    await lock.cron._fire(
      name,
      new Date("2030-01-01T00:01:00.000Z"),
      async () => {
        throw new Error("async boom");
      }
    );
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error.calls.argsFor(0).join(" ")).toContain(name);
  });

  it("swallows Redis errors", async function () {
    const name = newName();
    spyOn(console, "error");
    spyOn(client, "set").and.returnValue(
      Promise.reject(new Error("redis down"))
    );
    let called = false;
    await lock.cron._fire(name, new Date(), () => (called = true));
    expect(called).toEqual(false);
    expect(console.error).toHaveBeenCalled();
  });

  it('throws at registration for scope "host" without BLOT_HOST_ID', function () {
    delete process.env.BLOT_HOST_ID;
    expect(() =>
      lock.cron(newName(), "0 0 1 1 *", () => {}, { scope: "host" })
    ).toThrowError(/BLOT_HOST_ID/);
  });

  it("rejects an unknown scope", function () {
    expect(() =>
      lock.cron(newName(), "0 0 1 1 *", () => {}, { scope: "galaxy" })
    ).toThrowError(/scope/);
  });

  it('includes BLOT_HOST_ID in the key for scope "host"', async function () {
    const name = newName();
    process.env.BLOT_HOST_ID = "host-a";
    const fireDate = new Date("2030-01-01T00:00:00.000Z");
    let count = 0;
    const fn = () => count++;
    await lock.cron._fire(name, fireDate, fn, { scope: "host" });
    await lock.cron._fire(name, fireDate, fn, { scope: "host" });
    process.env.BLOT_HOST_ID = "host-b";
    await lock.cron._fire(name, fireDate, fn, { scope: "host" });
    expect(count).toEqual(2);
    expect(
      await client.exists(
        "cron:" + name + ":" + fireDate.toISOString() + ":host-a"
      )
    ).toEqual(1);
  });

  it("returns a cancellable node-schedule job", function () {
    const job = lock.cron(newName(), "0 0 1 1 *", () => {});
    expect(typeof job.cancel).toEqual("function");
    expect(job.cancel()).toEqual(true);
  });

  it("fires through node-schedule on two registrations but runs fn once", async function () {
    const name = newName();
    let count = 0;
    const fn = () => count++;
    const date = new Date(Date.now() + 1000);
    const a = lock.cron(name, date, fn);
    const b = lock.cron(name, date, fn);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    a.cancel();
    b.cancel();
    expect(count).toEqual(1);
  }, 10000);
});
