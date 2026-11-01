const cases = require("./helpers/contract");
const timeout = require("./helpers/timeout");
const createMemoryStore = require("../objectStore/memory");

describe("git store in-memory object store", function () {
  timeout(30 * 1000);

  for (const [name, run] of cases) {
    it(name, async function () {
      await run(createMemoryStore());
    });
  }

  it("counts what it is asked", async function () {
    const store = createMemoryStore();
    await store.put("k", Buffer.from("0123456789"));
    await store.read("k", 0, 4);
    await store.head("k");

    expect(store.stats.puts).toBe(1);
    expect(store.stats.reads).toBe(1);
    expect(store.stats.bytesRead).toBe(4);
    expect(store.stats.heads).toBe(1);
  });

  it("hands out copies, so a caller can't change what is stored", async function () {
    const store = createMemoryStore();
    const body = Buffer.from("abc");
    await store.put("k", body);
    body[0] = 0;
    (await store.get("k"))[1] = 0;
    (await store.read("k", 0, 3))[2] = 0;
    expect((await store.get("k")).toString()).toBe("abc");
  });

  it("gives each store its own id", function () {
    expect(createMemoryStore().id).not.toBe(createMemoryStore().id);
  });
});
