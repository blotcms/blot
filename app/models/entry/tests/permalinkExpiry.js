const redis = require("models/client");
const key = require("../key");
const {
  DELETED_ENTRY_TTL_SECONDS,
} = require("../../entries/sweepExpiredDeleted");

// A deleted entry's key expires (set.js), so its permalink key must too, or
// it points at nothing for ever
describe("entry.set permalink key of a deleted entry", function () {
  require("./setup")();

  beforeEach(function () {
    this.ttl = (url) => redis.ttl(key.url(this.blog.id, url));
  });

  it("gives the current permalink key the entry's TTL when deleted", async function () {
    const entry = await this.set("/a.txt", "Permalink: apple\nHello");

    expect(entry.url).toEqual("/apple");
    expect(await this.ttl("/apple")).toEqual(-1);

    await this.drop("/a.txt");

    const ttl = await this.ttl("/apple");
    expect(ttl).toBeGreaterThan(DELETED_ENTRY_TTL_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(DELETED_ENTRY_TTL_SECONDS);
  });

  it("clears the TTL when the file is re-added", async function () {
    await this.set("/a.txt", "Permalink: apple\nHello");
    await this.drop("/a.txt");
    expect(await this.ttl("/apple")).toBeGreaterThan(0);

    const entry = await this.set("/a.txt", "Permalink: apple\nHello again");

    expect(entry.url).toEqual("/apple");
    expect(await this.ttl("/apple")).toEqual(-1);
  });

  it("leaves a previous url's redirect key without a TTL", async function () {
    await this.set("/a.txt", "Permalink: apple\nHello");
    await this.set("/a.txt", "Permalink: banana\nHello");

    expect(await this.ttl("/apple")).toEqual(-1);

    await this.drop("/a.txt");

    expect(await this.ttl("/banana")).toBeGreaterThan(0);
    expect(await this.ttl("/apple")).toEqual(-1);
  });

  it("leaves a permalink key which points at another entry alone", async function () {
    await this.set("/a.txt", "Permalink: apple\nHello");
    await redis.set(key.url(this.blog.id, "/apple"), "/other.txt");

    await this.drop("/a.txt");

    expect(await this.ttl("/apple")).toEqual(-1);
    expect(await redis.get(key.url(this.blog.id, "/apple"))).toEqual(
      "/other.txt"
    );
  });
});
