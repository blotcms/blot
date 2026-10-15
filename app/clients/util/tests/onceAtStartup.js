// Startup one-offs run once per deploy, but "once" means a completed run: a
// process that crashed mid-work leaves its lock to expire and no done marker.
describe("onceAtStartup", function () {
  const { randomUUID } = require("crypto");
  const client = require("models/client");
  const onceAtStartup = require("../onceAtStartup");

  let name, prefix;

  beforeEach(function () {
    name = "test-" + randomUUID();
    prefix = "startup:" + name + ":" + onceAtStartup.releaseId();
    spyOn(console, "log");
    spyOn(console, "error");
  });

  afterEach(async function () {
    await client.del([prefix + ":done", prefix + ":running"]);
  });

  it("runs the work and marks it done", async function () {
    const fn = jasmine.createSpy("fn").and.returnValue(Promise.resolve());

    expect(await onceAtStartup(name, fn)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await client.exists(prefix + ":done")).toEqual(1);
    expect(await client.exists(prefix + ":running")).toEqual(0);
  });

  it("skips when the done marker exists", async function () {
    await client.set(prefix + ":done", "1", { PX: 60000 });
    const fn = jasmine.createSpy("fn");

    expect(await onceAtStartup(name, fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not mark done when the work fails, so a restart runs it again", async function () {
    let err;
    try {
      await onceAtStartup(name, async () => {
        throw new Error("boom");
      });
    } catch (e) {
      err = e;
    }
    expect(err && err.message).toEqual("boom");
    expect(await client.exists(prefix + ":done")).toEqual(0);

    const fn = jasmine.createSpy("fn").and.returnValue(Promise.resolve());
    expect(await onceAtStartup(name, fn)).toBe(true);
  });

  it("waits out a crashed holder's lock and runs the work", async function () {
    // What a crashed process leaves: a lock key about to expire, no marker
    await client.set(prefix + ":running", "crashed:1", { PX: 1500 });
    const fn = jasmine.createSpy("fn").and.returnValue(Promise.resolve());

    expect(await onceAtStartup(name, fn)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  }, 20000);

  it("runs the work once for two concurrent callers", async function () {
    const fn = jasmine.createSpy("fn").and.callFake(
      () => new Promise((resolve) => setTimeout(resolve, 300))
    );

    const results = await Promise.all([
      onceAtStartup(name, fn),
      onceAtStartup(name, fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(results.sort()).toEqual([false, true]);
  }, 20000);
});
