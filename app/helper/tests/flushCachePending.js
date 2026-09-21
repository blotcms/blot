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
});
