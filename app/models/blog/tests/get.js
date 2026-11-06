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

  it("calls back once with the blog", function (done) {
    get({ id: this.blog.id }, (err, blog) => {
      if (err) return done.fail(err);
      expect(blog.id).toBe(this.blog.id);
      done();
    });
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

  // Callers (Blog.extend among them) change the blog they get, so each get
  // must return a blog of its own, even when the client-side cache serves
  // the hash
  it("returns a fresh blog each time, unaffected by changes to an earlier one", async function () {
    const first = await get({ id: this.blog.id });
    first.title = "changed by a caller";
    first.converters.markdown = !first.converters.markdown;
    first.menu.push({ id: "x", label: "added" });

    const second = await get({ id: this.blog.id });
    expect(second.title).toBe(this.blog.title);
    expect(second.converters.markdown).toBe(!first.converters.markdown);
    expect(second.menu.length).toBe(first.menu.length - 1);
  });

  it("extends a fetched blog the same as before, and still normalizes other blogs", async function () {
    const extend = require("../extend");

    const fetched = extend(await get({ id: this.blog.id }));
    expect(typeof fetched.converters.markdown).toBe("boolean");
    expect(fetched.imageExif).toBeDefined();

    // Not from get: extend normalizes it itself
    const handBuilt = extend({ id: "x", handle: "x", menu: [] });
    expect(handBuilt.converters.markdown).toBe(true);
    expect(handBuilt.imageExif).toBe("off");
  });
});
