const client = require("models/client");
const purgeCdnUrlsOnce = require("../purgeCdnUrlsOnce");

describe("purgeCdnUrlsOnce", function () {
  beforeEach(async function () {
    await client.del("cdn:purged-on-boot");
  });

  it("purges once for the same URLs and again when they change", async function () {
    const calls = [];
    const purge = async (urls) => calls.push(urls);

    expect(await purgeCdnUrlsOnce(["/a-1"], purge)).toBe(true);
    expect(await purgeCdnUrlsOnce(["/a-1"], purge)).toBe(false);
    expect(await purgeCdnUrlsOnce(["/a-2"], purge)).toBe(true);
    expect(calls).toEqual([["/a-1"], ["/a-2"]]);
  });

  it("purges nothing when Redis refuses the write", async function () {
    const calls = [];
    const set = client.set;
    client.set = async () => {
      throw new Error("READONLY You can't write against a read only replica.");
    };

    try {
      await purgeCdnUrlsOnce(["/a-1"], async (urls) => calls.push(urls));
    } catch (e) {}
    client.set = set;

    expect(calls).toEqual([]);
  });
});
