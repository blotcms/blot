describe("scripts/storage/remove-ignored-files", function () {
  var client = require("models/client");
  var folder = require("storage/folder");
  var limit = require("build/converters/post-source-size").MARKDOWN.bytes;
  var { removeFor, key } = require("../remove-ignored-files");

  global.test.blog();

  it("flags the files still too large, and deletes the hash, only with apply", async function () {
    var blogID = this.blog.id;

    await folder.write(blogID, "/big.md", Buffer.alloc(limit + 1, 32));
    await folder.write(blogID, "/shrunk.md", "small now");
    await client.hSet(key(blogID), "/big.md", "TOO_LARGE");
    await client.hSet(key(blogID), "/shrunk.md", "TOO_LARGE");
    await client.hSet(key(blogID), "/gone.md", "TOO_LARGE");
    await client.hSet(key(blogID), "/_public.txt", "PUBLIC_FILE");

    expect(await removeFor(blogID, false)).toEqual({ paths: 4, flagged: 1 });
    expect(await client.exists(key(blogID))).toBe(1);
    expect((await folder.stat(blogID, "/big.md")).flags).toBeUndefined();

    expect(await removeFor(blogID, true)).toEqual({ paths: 4, flagged: 1 });
    expect(await client.exists(key(blogID))).toBe(0);
    expect((await folder.stat(blogID, "/big.md")).flags).toEqual([
      { code: "POST_TOO_LARGE", size: limit + 1, limit: limit },
    ]);
    expect((await folder.stat(blogID, "/shrunk.md")).flags).toBeUndefined();

    expect(await removeFor(this.blog.id, true)).toBeNull();
  });

  it("leaves a key of another type alone", async function () {
    await client.set(key(this.blog.id), "not a hash");

    expect(await removeFor(this.blog.id, true)).toEqual({ type: "string" });
    expect(await client.get(key(this.blog.id))).toBe("not a hash");

    await client.del(key(this.blog.id));
  });
});
