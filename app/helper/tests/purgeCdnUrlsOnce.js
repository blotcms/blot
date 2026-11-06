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

  it("purges once when called concurrently", async function () {
    const calls = [];
    const purge = async (urls) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      calls.push(urls);
    };

    await Promise.all([
      purgeCdnUrlsOnce(["/a-1"], purge),
      purgeCdnUrlsOnce(["/a-1"], purge),
      purgeCdnUrlsOnce(["/a-1"], purge),
    ]);

    expect(calls.length).toBe(1);
  });

  it("purges again on the next call after a failed or thrown purge", async function () {
    const calls = [];

    expect(await purgeCdnUrlsOnce(["/a-1"], async () => false)).toBe(false);

    try {
      await purgeCdnUrlsOnce(["/a-1"], async () => {
        throw new Error("boom");
      });
    } catch (e) {}

    expect(await purgeCdnUrlsOnce(["/a-1"], async (u) => calls.push(u))).toBe(
      true
    );
    expect(calls).toEqual([["/a-1"]]);
  });

  it("restores the previous fingerprint when a purge fails", async function () {
    await purgeCdnUrlsOnce(["/a-1"], async () => true);
    expect(await purgeCdnUrlsOnce(["/a-2"], async () => false)).toBe(false);
    // /a-1 was what was last purged, so it is not purged again
    expect(await purgeCdnUrlsOnce(["/a-1"], async () => true)).toBe(false);
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
