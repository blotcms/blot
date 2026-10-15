describe("helper/lock once", function () {
  const lock = require("helper/lock");
  const client = require("models/client");
  const { randomUUID } = require("crypto");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const key = "test:helper-lock:once:" + randomUUID();

  afterEach(async function () {
    await client.del(key);
  });

  it("is true for the first caller and false for the second", async function () {
    expect(await lock.once(key, 5000)).toEqual(true);
    expect(await lock.once(key, 5000)).toEqual(false);
  });

  it("only lets one of many concurrent callers win", async function () {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => lock.once(key, 5000))
    );
    expect(results.filter(Boolean).length).toEqual(1);
  });

  it("is true again after the ttl expires", async function () {
    expect(await lock.once(key, 100)).toEqual(true);
    await sleep(200);
    expect(await lock.once(key, 100)).toEqual(true);
  });
});
