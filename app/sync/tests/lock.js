describe("sync lock heartbeat", function () {
  const syncLock = require("sync/lock");
  const client = require("models/client");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it("never has more than one EXTEND in flight when Redis is slow", async function () {
    const blogID = "blog_lock_heartbeat_" + Date.now();
    const original = client.eval.bind(client);
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let slow = false;

    spyOn(client, "eval").and.callFake(async (...args) => {
      if (!slow || !String(args[0]).includes("PEXPIRE"))
        return original(...args);
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        // Each EXTEND takes about five heartbeats to answer
        await sleep(250);
        return await original(...args);
      } finally {
        active--;
      }
    });

    const compromised = [];
    const handle = await syncLock.lock(blogID, {
      ttl: 5000,
      heartbeat: 50,
      onCompromised: (e) => compromised.push(e),
    });

    try {
      slow = true;
      await sleep(700);
      slow = false;
      // Without the guard this would be about 14 calls, all overlapping
      expect(maxActive).toEqual(1);
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThan(5);
      expect(compromised.length).toEqual(0);
    } finally {
      slow = false;
      await sleep(300);
      await handle.release();
    }
  });

  it("still calls onCompromised if the only EXTEND never answers", async function () {
    spyOn(console, "error");
    const blogID = "blog_lock_heartbeat_hang_" + Date.now();
    const original = client.eval.bind(client);
    let extendCalls = 0;
    let hang = false;

    spyOn(client, "eval").and.callFake((...args) => {
      if (hang && String(args[0]).includes("PEXPIRE")) {
        extendCalls++;
        return new Promise(() => {});
      }
      return original(...args);
    });

    const compromised = [];
    const handle = await syncLock.lock(blogID, {
      ttl: 300,
      heartbeat: 40,
      onCompromised: (e) => compromised.push(e),
    });

    hang = true;
    const end = Date.now() + 3000;
    while (!compromised.length && Date.now() < end) await sleep(20);
    hang = false;

    expect(compromised.length).toEqual(1);
    expect(compromised[0].code).toEqual("ECOMPROMISED");
    expect(extendCalls).toEqual(1);
    await handle.release().catch(() => {});
  });
});
