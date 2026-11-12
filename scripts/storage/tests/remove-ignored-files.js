describe("scripts/storage/remove-ignored-files", function () {
  var client = require("models/client");
  var { removeFor, key } = require("../remove-ignored-files");

  global.test.blog();

  it("counts a blog's hash, and deletes it only with apply", async function () {
    await client.hSet(key(this.blog.id), "/big.md", "TOO_LARGE");
    await client.hSet(key(this.blog.id), "/_public.txt", "PUBLIC_FILE");

    expect(await removeFor(this.blog.id, false)).toEqual({ paths: 2 });
    expect(await client.exists(key(this.blog.id))).toBe(1);

    expect(await removeFor(this.blog.id, true)).toEqual({ paths: 2 });
    expect(await client.exists(key(this.blog.id))).toBe(0);

    expect(await removeFor(this.blog.id, true)).toBeNull();
  });

  it("leaves a key of another type alone", async function () {
    await client.set(key(this.blog.id), "not a hash");

    expect(await removeFor(this.blog.id, true)).toEqual({ type: "string" });
    expect(await client.get(key(this.blog.id))).toBe("not a hash");

    await client.del(key(this.blog.id));
  });
});
