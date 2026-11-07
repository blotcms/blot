describe("eachLimit", function () {
  const eachLimit = require("../eachLimit");

  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("never runs more than the limit at once and keeps the order of results", async function () {
    let running = 0;
    let peak = 0;

    const results = await eachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return n * 2;
    });

    expect(peak).toBe(3);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  it("resolves for no items", async function () {
    expect(await eachLimit([], 10, async () => {})).toEqual([]);
  });

  it("rejects with the first error and starts nothing more", async function () {
    const started = [];
    let error;

    try {
      await eachLimit([1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("two");
      });
    } catch (err) {
      error = err;
    }

    expect(error.message).toBe("two");
    expect(started).toEqual([1, 2]);
  });
});
