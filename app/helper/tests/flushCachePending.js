describe("flushCachePending", function () {
  const client = require("models/client");
  const flushCachePending = require("../flushCachePending");

  const target = "http://proxy-under-test.invalid:80";
  const pending = flushCachePending(client);

  afterEach(async function () {
    await client.del(`flushCache:pending:${target}`);
  });

  it("lists the hosts recorded for a proxy", async function () {
    await pending.add(target, ["a.example", "b.example"]);

    const entries = await pending.list(target);

    expect(entries.map(({ host }) => host).sort()).toEqual([
      "a.example",
      "b.example",
    ]);
    entries.forEach(({ score }) => expect(score).toBeGreaterThan(0));
  });

  it("returns nothing for a proxy with no failures", async function () {
    expect(await pending.list(target)).toEqual([]);
  });

  it("removes entries which have not changed since they were listed", async function () {
    await pending.add(target, ["a.example", "b.example"]);

    await pending.remove(target, await pending.list(target));

    expect(await pending.list(target)).toEqual([]);
  });

  it("keeps an entry which was recorded again after it was listed", async function () {
    await pending.add(target, ["a.example"]);
    const listed = await pending.list(target);

    // a later failure for the same host bumps its score
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pending.add(target, ["a.example"]);

    await pending.remove(target, listed);

    expect((await pending.list(target)).map(({ host }) => host)).toEqual([
      "a.example",
    ]);
  });

  it("ignores an empty removal", async function () {
    await pending.add(target, ["a.example"]);
    await pending.remove(target, []);
    expect((await pending.list(target)).length).toBe(1);
  });

  it("only lists entries recorded at or before the max score", async function () {
    await pending.add(target, ["old.example"], 1000);
    await pending.add(target, ["new.example"], 2000);

    const entries = await pending.list(target, 1500);

    expect(entries).toEqual([{ host: "old.example", score: 1000 }]);
  });

  it("limits the number of entries listed, oldest first", async function () {
    await pending.add(target, ["new.example"], 2000);
    await pending.add(target, ["old.example"], 1000);

    const entries = await pending.list(target, "+inf", 1);

    expect(entries).toEqual([{ host: "old.example", score: 1000 }]);
  });

  it("removes entries whose score has a fractional part", async function () {
    await pending.add(target, ["a.example"], 1793443313343.598);

    await pending.remove(target, await pending.list(target));

    expect(await pending.list(target)).toEqual([]);
  });

  it("ignores an empty list of hosts", async function () {
    await pending.add(target, []);

    expect(await pending.list(target)).toEqual([]);
  });

  it("stores an explicit score exactly", async function () {
    await pending.add(target, ["a.example"], 12345);

    expect(await pending.list(target)).toEqual([
      { host: "a.example", score: 12345 },
    ]);
  });
});
