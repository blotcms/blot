describe("dropbox retryRequest", function () {
  const retryRequest = require("../util/retryRequest");
  const originalDelays = retryRequest.delays;

  const fail = (status, extra) =>
    Object.assign(new Error("Response failed with a " + status + " code"), {
      status,
      ...extra,
    });

  beforeEach(function () {
    retryRequest.delays = [1, 1, 1];
  });

  afterEach(function () {
    retryRequest.delays = originalDelays;
  });

  it("retries a 500 and returns the later success", async function () {
    let calls = 0;
    const result = await retryRequest(async () => {
      if (++calls === 1) throw fail(500);
      return "ok";
    });
    expect(result).toEqual("ok");
    expect(calls).toEqual(2);
  });

  it("retries a 429", async function () {
    let calls = 0;
    const result = await retryRequest(async () => {
      if (++calls === 1) throw fail(429);
      return "ok";
    });
    expect(result).toEqual("ok");
  });

  it("honours retry_after on a 429", async function () {
    const started = Date.now();
    let calls = 0;
    await retryRequest(async () => {
      if (++calls === 1)
        throw fail(429, { error: { error: { retry_after: 1 } } });
      return "ok";
    });
    expect(Date.now() - started).not.toBeLessThan(950);
  });

  it("throws a persistent 500 after the retries are used up", async function () {
    let calls = 0;
    let error;
    try {
      await retryRequest(async () => {
        calls++;
        throw fail(500);
      });
    } catch (err) {
      error = err;
    }
    expect(error.status).toEqual(500);
    expect(calls).toEqual(4);
  });

  it("does not retry 409, 401 or errors without a status", async function () {
    for (const err of [fail(409), fail(401), new Error("boom")]) {
      let calls = 0;
      let error;
      try {
        await retryRequest(async () => {
          calls++;
          throw err;
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBe(err);
      expect(calls).toEqual(1);
    }
  });
});
