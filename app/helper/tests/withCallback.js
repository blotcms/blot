describe("withCallback", function () {
  const withCallback = require("../withCallback");

  const double = withCallback(async function double(x) {
    return x * 2;
  });

  const fail = withCallback(async function fail() {
    throw new Error("nope");
  });

  it("returns a promise without a callback", async function () {
    expect(await double(2)).toBe(4);
    const err = await fail().catch((err) => err);
    expect(err.message).toBe("nope");
  });

  it("calls back with the result", function (done) {
    const returned = double(2, function (err, result) {
      expect(err).toBe(null);
      expect(result).toBe(4);
      done();
    });

    expect(returned).toBeUndefined();
  });

  it("calls back with the error", function (done) {
    fail(function (err, result) {
      expect(err.message).toBe("nope");
      expect(result).toBeUndefined();
      done();
    });
  });

  it("calls back with a synchronous throw from a plain function", function (done) {
    const sync = withCallback(function sync() {
      throw new Error("sync");
    });

    sync(function (err) {
      expect(err.message).toBe("sync");
      done();
    });
  });

  it("keeps this", async function () {
    const object = {
      value: 3,
      get: withCallback(async function () {
        return this.value;
      }),
    };

    expect(await object.get()).toBe(3);
  });

  it("calls a throwing callback once and rethrows its error", function (done) {
    spyOn(console, "error");
    let calls = 0;

    const listeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");

    process.once("uncaughtException", function (err) {
      listeners.forEach((listener) =>
        process.on("uncaughtException", listener)
      );
      expect(err.message).toBe("in callback");
      expect(calls).toBe(1);
      expect(console.error).toHaveBeenCalled();
      done();
    });

    double(2, function () {
      calls++;
      throw new Error("in callback");
    });
  });

  it("leaves an async callback's rejection unhandled", function (done) {
    const listeners = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");

    process.once("unhandledRejection", function (err) {
      listeners.forEach((listener) =>
        process.on("unhandledRejection", listener)
      );
      expect(err.message).toBe("in async callback");
      done();
    });

    double(2, async function () {
      throw new Error("in async callback");
    });
  });
});
