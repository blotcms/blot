describe("serialByKey", function () {
  const serialByKey = require("helper/serialByKey");
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("runs calls with one key one at a time, in the order made", async function () {
    const run = serialByKey();
    const events = [];

    const task = (name) => async () => {
      events.push("start " + name);
      await tick();
      await tick();
      events.push("end " + name);
      return name;
    };

    const results = await Promise.all([
      run("a", task(1)),
      run("a", task(2)),
      run("a", task(3)),
    ]);

    expect(results).toEqual([1, 2, 3]);
    expect(events).toEqual([
      "start 1",
      "end 1",
      "start 2",
      "end 2",
      "start 3",
      "end 3",
    ]);
  });

  it("doesn't make calls with other keys wait", async function () {
    const run = serialByKey();
    const events = [];
    let release;

    const first = run("a", async () => {
      events.push("start a");
      await new Promise((resolve) => (release = resolve));
      events.push("end a");
    });

    await run("b", async () => events.push("b"));

    expect(events).toEqual(["start a", "b"]);

    release();
    await first;

    expect(events).toEqual(["start a", "b", "end a"]);
  });

  it("passes on a rejection without holding up the next call", async function () {
    const run = serialByKey();

    const failed = run("a", async () => {
      throw new Error("failed");
    });
    const next = run("a", async () => "next");

    await expectAsync(failed).toBeRejectedWithError("failed");
    expect(await next).toBe("next");
  });

  it("runs a call made after the queue emptied straight away", async function () {
    const run = serialByKey();

    await run("a", async () => {});

    let ran = false;
    const pending = run("a", async () => (ran = true));

    await tick();
    expect(ran).toBe(true);
    await pending;
  });
});
