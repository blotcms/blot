describe("dropbox content hashes", function () {
  const hashes = require("../util/hashes");
  const crypto = require("crypto");
  const blogID = "blog_dropboxhashestest" + Date.now();

  const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");
  const sha256 = (text) =>
    crypto.createHash("sha256").update(text).digest("hex");

  afterEach(async function () {
    await hashes.drop(blogID);
  });

  it("keeps the first 12 bytes of each hash, by SHA-1", async function () {
    await hashes.add(blogID, sha1("a"), sha256("a"));
    const known = await hashes.load(blogID);

    expect(known.get(sha1("a"))).toEqual(sha256("a").slice(0, 24));
    expect(known.get(sha1("b"))).toBeUndefined();
  });

  it("ignores a pair that isn't two hex hashes", async function () {
    await hashes.add(blogID, "nope", sha256("a"));
    await hashes.add(blogID, sha1("a"), undefined);
    const known = await hashes.load(blogID);

    expect(known.get(sha1("a"))).toBeUndefined();
  });

  it("keeps only what a complete walk used", async function () {
    await hashes.add(blogID, sha1("a"), sha256("a"));
    await hashes.add(blogID, sha1("b"), sha256("b"));

    const walk = await hashes.load(blogID);
    walk.get(sha1("a"));
    walk.set(sha1("c"), sha256("c"));
    await walk.save({ complete: true });

    const known = await hashes.load(blogID);
    expect(known.get(sha1("a"))).toEqual(sha256("a").slice(0, 24));
    expect(known.get(sha1("b"))).toBeUndefined();
    expect(known.get(sha1("c"))).toEqual(sha256("c").slice(0, 24));
  });

  it("adds to what was there after a walk that stopped part way", async function () {
    await hashes.add(blogID, sha1("a"), sha256("a"));

    const walk = await hashes.load(blogID);
    walk.set(sha1("b"), sha256("b"));
    await walk.save({ complete: false });

    const known = await hashes.load(blogID);
    expect(known.get(sha1("a"))).toEqual(sha256("a").slice(0, 24));
    expect(known.get(sha1("b"))).toEqual(sha256("b").slice(0, 24));
  });

  it("stores 24 bytes a file", async function () {
    await hashes.add(blogID, sha1("a"), sha256("a"));
    await hashes.add(blogID, sha1("b"), sha256("b"));

    expect(await require("models/client").strLen(hashes.key(blogID))).toEqual(
      48
    );
  });
});
