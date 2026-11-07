describe("Blog.get", function () {
  var get = require("../get");
  var key = require("../key");
  var client = require("models/client");

  global.test.blog();

  it("returns a promise without a callback", async function () {
    const blog = await get({ id: this.blog.id });
    expect(blog.id).toBe(this.blog.id);
    expect(await get({ id: "nonexistent-" + Date.now() })).toBeUndefined();
  });

  it("throws when given a callback", async function () {
    // The callback form is gone: passing one throws instead of calling back.
    try {
      await get({ id: this.blog.id }, function () {});
      fail("should have thrown");
    } catch (err) {
      expect(err.message).toMatch(/no longer takes a callback/);
    }
  });

  it("falls back to safe image metadata defaults", async function () {
    await client.hDel(key.info(this.blog.id), "imageExif");

    const blog = await get({ id: this.blog.id });

    expect(blog.imageExif).toBe("off");
    expect(blog.isImageExifOff).toBe(true);
    expect(blog.isImageExifBasic).toBe(false);
  });

  it("falls back to converter defaults when missing", async function () {
    await client.hDel(key.info(this.blog.id), "converters");

    const blog = await get({ id: this.blog.id });

    expect(blog.converters.img).toBe(true);
    expect(blog.converters.markdown).toBe(true);
    expect(blog.converters.docx).toBe(true);
  });
});
