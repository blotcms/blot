describe("promiseOnly", function () {
  const promiseOnly = require("../promiseOnly");
  const { promisify } = require("util");

  const double = promiseOnly(async function double(x) {
    return x * 2;
  });

  it("passes a promise through", async function () {
    expect(await double(2)).toEqual(4);
  });

  it("throws a TypeError naming the function when given a callback", function () {
    let error;

    try {
      double(2, function () {});
    } catch (err) {
      error = err;
    }

    expect(error instanceof TypeError).toBe(true);
    expect(error.message).toContain("double no longer takes a callback");
  });

  it("rejects under util.promisify", async function () {
    let error;

    try {
      await promisify(double)(2);
    } catch (err) {
      error = err;
    }

    expect(error instanceof TypeError).toBe(true);
    expect(error.message).toContain("double");
  });

  it("preserves this", async function () {
    const owner = {
      guarded: promiseOnly(async function whoami() {
        return this;
      }),
    };

    expect(await owner.guarded()).toBe(owner);
  });
});
