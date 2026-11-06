describe("dropbox retry", function () {
  const retry = require("../util/retry");

  const fail = (status) =>
    Object.assign(new Error("Response failed with a " + status + " code"), {
      status,
    });

  // A short interval keeps the backoff out of the spec's way
  const options = (extra) =>
    Object.assign({ interval: () => 1, errorFilter: () => true }, extra);

  it("returns a promise for the result when called without a callback", async function () {
    const fn = retry(async (a, b) => a + b, options());
    expect(await fn(1, 2)).toEqual(3);
  });

  it("calls back once with the result", function (done) {
    const fn = retry(async (a) => a * 2, options());

    fn(21, function (err, result) {
      expect(err).toBeNull();
      expect(result).toEqual(42);
      done();
    });
  });

  it("tries again after a failure and uses the later success", async function () {
    let calls = 0;
    const fn = retry(async () => {
      if (++calls < 3) throw fail(500);
      return "ok";
    }, options());

    expect(await fn()).toEqual("ok");
    expect(calls).toEqual(3);
  });

  it("gives up after the configured number of attempts with the last error", async function () {
    let calls = 0;
    const fn = retry(
      async () => {
        throw fail(500 + ++calls);
      },
      options({ times: 3 })
    );

    let error;
    try {
      await fn();
    } catch (err) {
      error = err;
    }

    expect(calls).toEqual(3);
    expect(error.status).toEqual(503);
  });

  it("does not try again when the error filter refuses", async function () {
    let calls = 0;
    const fn = retry(
      async () => {
        calls++;
        throw fail(401);
      },
      options({ errorFilter: (err) => err.status !== 401 })
    );

    let error;
    try {
      await fn();
    } catch (err) {
      error = err;
    }

    expect(calls).toEqual(1);
    expect(error.status).toEqual(401);
  });

  it("calls back with the error once the attempts run out", function (done) {
    const fn = retry(
      async () => {
        throw fail(500);
      },
      options({ times: 2 })
    );

    fn(function (err, result) {
      expect(err.status).toEqual(500);
      expect(result).toBeUndefined();
      done();
    });
  });
});
