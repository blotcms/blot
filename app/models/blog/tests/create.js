describe("Blog.create", function () {
  var create = require("../create");
  var remove = require("../remove");
  var getAllIDs = require("../getAllIDs");
  var extend = require("../extend");

  // Create a test user before each spec
  global.test.user();

  // Clean up blogs created during tests
  afterEach(async function () {
    var blogs = (this.blogs || []).slice();

    if (this.blog) blogs.push(this.blog);

    // Cleanup errors are ignored, as they were when this used callbacks
    await Promise.all(blogs.map((blog) => remove(blog.id).catch(() => {})));
  });

  it("creates a blog", async function () {
    this.blog = await create(this.user.uid, { handle: "exampleblog" }); // will be cleaned up at the end of this test

    expect(this.blog).toEqual(jasmine.any(Object));
  });

  it("creates the blog's folder", async function () {
    var folder = require("storage/folder");

    this.blog = await create(this.user.uid, { handle: "exampleblog" });

    expect(await folder.exists(this.blog.id, "/")).toBe(true);
    expect(await folder.listNames(this.blog.id, "/")).toEqual([]);
  });

  it("defaults image exif preferences", async function () {
    this.blog = extend(await create(this.user.uid, { handle: "exampleblog" }));

    expect(this.blog.imageExif).toBe("basic");
    expect(this.blog.isImageExifBasic).toBe(true);
    expect(this.blog.isImageExifOff).toBe(false);

    expect(this.blog.converters).toEqual({
      html: true,
      img: true,
      webloc: true,
      gdoc: true,
      docx: true,
      rtf: true,
      odt: true,
      org: true,
      markdown: true,
    });
  });

  it("adds created blog to list of all blogs", async function () {
    this.blog = await create(this.user.uid, { handle: "exampleblog" }); // will be cleaned up at the end of this test

    expect(await getAllIDs()).toContain(this.blog.id);
  });

  it("creates blogs with isolated plugin defaults", async function () {
    var firstBlog = await create(this.user.uid, { handle: "firstblog" });

    this.blogs = [firstBlog];

    firstBlog.plugins.typeset.enabled = false;
    firstBlog.plugins.typeset.options.smallCaps = false;

    var secondBlog = await create(this.user.uid, { handle: "secondblog" });

    this.blogs.push(secondBlog);

    expect(secondBlog.plugins.typeset.enabled).toBe(true);
    expect(secondBlog.plugins.typeset.options.smallCaps).toBe(true);
  });

  it("returns a promise without a callback", async function () {
    this.blog = await create(this.user.uid, { handle: "exampleblog" });

    expect(this.blog.handle).toEqual("exampleblog");
    expect(await getAllIDs()).toContain(this.blog.id);
  });

  it("rejects with validate's errors object", async function () {
    this.blog = await create(this.user.uid, { handle: "exampleblog" });

    var errors = await create(this.user.uid, { handle: "exampleblog" }).catch(
      function (err) {
        return err;
      }
    );

    expect(errors instanceof Error).toBe(false);
    expect(errors.handle).toEqual(jasmine.any(Error));
  });
});
